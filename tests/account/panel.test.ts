import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import AccountPanel from '../../src/components/AccountPanel.vue';
import type { AccountStatus, ConnectionState, MailError, MutationAccess, SyncInfo } from '../../src/lib/ipc/client';
import type { AccountAction } from '../../src/composables/useMailbox';
import { createKeyEvent } from '../helpers';
import { css } from '../support/css-contract';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

function status(patch: {
  connection?: ConnectionState;
  mutationAccess?: MutationAccess;
  sync?: Partial<SyncInfo>;
  account?: AccountStatus['account'];
} = {}): AccountStatus {
  return {
    mode: 'gmail',
    connection: patch.connection ?? 'connected',
    account: patch.account === undefined ? { accountId: 'gmail-account', emailAddress: 'operator@example.test' } : patch.account,
    mutationAccess: patch.mutationAccess ?? 'read_only',
    sync: {
      state: 'idle', lastSyncedAt: null, error: null, cachedConversations: 18,
      initialSyncComplete: true, coverageLimit: 100, ...patch.sync,
    },
  };
}
function mountPanel(s: AccountStatus, extra: { busy?: AccountAction | null; actionError?: MailError | null; transitioning?: boolean } = {}): VueWrapper {
  wrapper?.unmount();
  wrapper = mount(AccountPanel, { props: { status: s, busy: extra.busy ?? null, actionError: extra.actionError ?? null, transitioning: extra.transitioning }, attachTo: document.body });
  return wrapper;
}
const test = (w: VueWrapper, id: string) => w.find(`[data-test="${id}"]`);

describe('AccountPanel structure', () => {
  it('has no card chrome, no second heading, and labelled sections separated by spacing only', () => {
    const w = mountPanel(status());
    expect(w.find('h1, h2').exists()).toBe(false);
    expect(w.findAll('.account-label').map((n) => n.text())).toEqual(['Connection', 'Sync', 'Permissions', 'Session']);
    expect(w.findAll('.account-section')).toHaveLength(4);
    expect(w.find('[data-test="disposable-account-note"]').exists()).toBe(false);
    expect(w.text()).not.toContain('Disposable');
  });

  it('shows one connection line and one mode line, with the cached-reading fact in the mode title', () => {
    const w = mountPanel(status());
    expect(test(w, 'account-email').text()).toBe('operator@example.test');
    expect(test(w, 'account-connection').text()).toBe('Connected');
    expect(w.get('.account-connection-line').text()).toBe('operator@example.test · Connected');
    expect(test(w, 'account-mode').text()).toBe('Gmail · read-only');
    expect(test(w, 'account-mode').attributes('title')).toContain('Cached reading remains available');
    expect(mountPanel(status({ mutationAccess: 'enabled' })).get('[data-test="account-mode"]').text()).toBe('Gmail · mailbox actions enabled');
    expect(mountPanel(status({ mutationAccess: 'upgrading' })).get('[data-test="account-mode"]').text()).toBe('Gmail · permission request pending');
  });

  it.each([
    ['disconnected', null, 'Not connected'],
    ['auth_required', 'operator@example.test', 'Sign-in expired'],
    ['authenticating', null, 'Finish sign-in in your browser'],
    ['not_configured', null, 'Not configured'],
  ] as const)('labels the %s connection', (connection, email, label) => {
    const w = mountPanel(status({ connection, account: email ? { accountId: 'a', emailAddress: email } : null }));
    expect(test(w, 'account-connection').text()).toBe(label);
    expect(test(w, 'account-email').exists()).toBe(email !== null);
  });

  it('gives not-configured a next step and auth-required one terse line that does not repeat the connection label', () => {
    const nc = mountPanel(status({ connection: 'not_configured', account: null }));
    expect(test(nc, 'account-not-configured').text()).toBe('Gmail is not configured on this device. Add a Google client ID to the launch environment, then restart.');
    expect(test(nc, 'account-not-configured').text()).not.toMatch(/unavailable/i);
    const ar = mountPanel(status({ connection: 'auth_required' }));
    expect(test(ar, 'account-auth-required').text()).toBe('Cached mail stays readable. Sign in again to sync.');
    // "Sign-in expired" is said once in the drawer, by the connection label.
    expect(ar.text().match(/Sign-in expired/g)).toHaveLength(1);
    expect(test(ar, 'account-connect').text()).toBe('Sign in again');
  });

  it('names the connect button Connect Gmail when disconnected, and offers none when not configured (nothing to connect with)', () => {
    expect(test(mountPanel(status({ connection: 'disconnected', account: null })), 'account-connect').text()).toBe('Connect Gmail');
    const nc = mountPanel(status({ connection: 'not_configured', account: null }));
    expect(test(nc, 'account-connect').exists()).toBe(false);
    expect(nc.text()).not.toMatch(/Connect Gmail/);
    expect(test(nc, 'account-not-configured').text()).toContain('Add a Google client ID to the launch environment, then restart.');
  });

  it('says only the facts that are still true after sign-in expires: the cache stays, the idle and never-synced words do not', () => {
    const expired = mountPanel(status({ connection: 'auth_required', sync: { state: 'idle', lastSyncedAt: null, cachedConversations: 18 } }));
    // The mode is a real grant and the cache is real, so both stay.
    expect(test(expired, 'account-mode').exists()).toBe(true);
    expect(test(expired, 'account-cached').text()).toBe('18 conversations cached');
    // "Idle" is a sync state and "Never synced" a claim about the past; neither is known while signed out.
    expect(test(expired, 'account-sync-state').exists()).toBe(false);
    expect(expired.text()).not.toMatch(/Idle|Never synced/);
    // A known last sync date is still real and still shown.
    const synced = mountPanel(status({ connection: 'auth_required', sync: { lastSyncedAt: '2025-01-01T00:00:00.000Z', cachedConversations: 18 } }));
    expect(test(synced, 'account-last-synced').text()).toContain('Last synced');
    expect(test(synced, 'account-sync-state').exists()).toBe(false);
    // A connected account keeps the state word.
    expect(test(mountPanel(status()), 'account-sync-state').text()).toBe('Idle');
  });

  it('shows the permission mode only where a grant is real (connected or signed out), not before there is an account', () => {
    for (const connection of ['connected', 'auth_required'] as const) {
      expect(test(mountPanel(status({ connection })), 'account-mode').exists(), connection).toBe(true);
    }
    for (const connection of ['disconnected', 'not_configured', 'authenticating'] as const) {
      expect(test(mountPanel(status({ connection, account: null })), 'account-mode').exists(), connection).toBe(false);
    }
  });

  it('hides the Sync section when there is nothing to sync (not connected, not configured, signing in)', () => {
    for (const connection of ['disconnected', 'not_configured', 'authenticating'] as const) {
      const w = mountPanel(status({ connection, account: null, sync: { cachedConversations: 0 } }));
      expect(w.findAll('.account-label').map((n) => n.text()), connection).not.toContain('Sync');
      expect(test(w, 'account-sync-state').exists(), connection).toBe(false);
      expect(w.text()).not.toMatch(/Never synced|conversations cached/);
    }
    // A signed-out account keeps its cached facts: the cache is real.
    const expired = mountPanel(status({ connection: 'auth_required' }));
    expect(expired.findAll('.account-label').map((n) => n.text())).toContain('Sync');
    expect(test(expired, 'account-cached').exists()).toBe(true);
  });
});

describe('AccountPanel sync section', () => {
  it('labels the sync facts as one separated line: state · last synced · cached', () => {
    const w = mountPanel(status({ sync: { cachedConversations: 18 } }));
    const line = w.get('.account-sync-line');
    expect(line.findAll(':scope > span').map((span) => span.text())).toEqual(['Idle', '·', 'Never synced', '·', '18 conversations cached']);
    // Separators are decoration for the eye; assistive text reads the three facts.
    const seps = line.findAll('.account-sep');
    expect(seps).toHaveLength(2);
    for (const sep of seps) expect(sep.attributes('aria-hidden')).toBe('true');
  });

  it('says a typed failure once: the error line with Retry replaces the "Failed" state word', () => {
    const failed = mountPanel(status({ sync: { state: 'error', error: { kind: 'rate_limited' }, cachedConversations: 3 } }));
    expect(test(failed, 'account-sync-state').exists()).toBe(false);
    expect(failed.get('.account-sync-line').findAll(':scope > span').map((span) => span.text())).toEqual(['Never synced', '·', '3 conversations cached']);
    expect(test(failed, 'account-sync-error').text()).toContain('Sync failed: The provider is rate limiting');
    expect(failed.text().match(/Sync failed/g)).toHaveLength(1);
    expect(failed.text()).not.toMatch(/\bFailed\b/);
    // Without a typed cause there is no error line, so the state word is the one statement.
    const untyped = mountPanel(status({ sync: { state: 'error', error: null } }));
    expect(test(untyped, 'account-sync-state').text()).toBe('Failed');
  });

  it('hides the coverage line when nothing is cached or the account is not connected', () => {
    expect(test(mountPanel(status({ sync: { cachedConversations: 0 } })), 'account-coverage').exists()).toBe(false);
    expect(test(mountPanel(status({ connection: 'disconnected', account: null, sync: { cachedConversations: 0 } })), 'account-coverage').exists()).toBe(false);
    expect(test(mountPanel(status({ connection: 'not_configured', account: null })), 'account-coverage').exists()).toBe(false);
    // Cached mail under an expired sign-in is still bounded, so the fact still applies.
    expect(test(mountPanel(status({ connection: 'auth_required', sync: { cachedConversations: 18 } })), 'account-coverage').exists()).toBe(true);
    expect(test(mountPanel(status({ sync: { cachedConversations: 1 } })), 'account-coverage').exists()).toBe(true);
  });

  it('hides Sync now while the inline Retry shows, and keeps it when the error has no typed cause', () => {
    const failed = mountPanel(status({ sync: { state: 'error', error: { kind: 'network_unavailable' } } }));
    expect(test(failed, 'account-sync-retry').exists()).toBe(true);
    expect(test(failed, 'account-sync').exists()).toBe(false);
    // An error state with no sentence has no Retry, so Sync now stays the only way to ask again.
    const untyped = mountPanel(status({ sync: { state: 'error', error: null } }));
    expect(test(untyped, 'account-sync-retry').exists()).toBe(false);
    expect(test(untyped, 'account-sync').exists()).toBe(true);
  });

  it('reads as one line with a correct plural', () => {
    const w = mountPanel(status({ sync: { cachedConversations: 1, lastSyncedAt: '2025-01-01T00:00:00.000Z' } }));
    expect(test(w, 'account-sync-state').text()).toBe('Idle');
    expect(test(w, 'account-last-synced').text()).toMatch(/^Last synced /);
    expect(test(w, 'account-cached').text()).toBe('1 conversation cached');
    expect(test(w, 'account-cached').text()).not.toContain('(s)');
    expect(mountPanel(status({ sync: { cachedConversations: 0 } })).get('[data-test="account-cached"]').text()).toBe('0 conversations cached');
    expect(mountPanel(status({ sync: { cachedConversations: 18 } })).get('[data-test="account-cached"]').text()).toBe('18 conversations cached');
    // One form, also during the first sync: the drawer's standalone fact never shortens to "N cached".
    const first = (cachedConversations: number) => mountPanel(status({ sync: { state: 'syncing', cachedConversations, initialSyncComplete: false } }));
    expect(test(first(0), 'account-cached').text()).toBe('0 conversations cached');
    expect(test(first(1), 'account-cached').text()).toBe('1 conversation cached');
  });

  it('puts the first-sync count on the line and the bounded-coverage fact on one short Ash second line', () => {
    const w = mountPanel(status({ sync: { state: 'syncing', cachedConversations: 7, initialSyncComplete: false } }));
    expect(test(w, 'account-sync-state').text()).toBe('Syncing first mail…');
    expect(test(w, 'account-cached').text()).toBe('7 conversations cached');
    expect(test(w, 'account-coverage').text()).toBe('Up to 100 conversations are cached; older mail may be missing.');
    expect(test(w, 'account-coverage').classes()).toContain('account-note');
    // After the sync the same short fact stays; with no cap there is no second line.
    expect(test(mountPanel(status()), 'account-coverage').text()).toBe('Up to 100 conversations are cached; older mail may be missing.');
    expect(test(mountPanel(status({ sync: { coverageLimit: 0 } })), 'account-coverage').exists()).toBe(false);
  });

  it('keeps Sync now while connected and disables it while a sync runs', () => {
    expect(test(mountPanel(status()), 'account-sync').text()).toBe('Sync now');
    expect(test(mountPanel(status({ sync: { state: 'syncing' } })), 'account-sync').attributes('disabled')).toBeDefined();
    expect(test(mountPanel(status({ connection: 'disconnected' })), 'account-sync').exists()).toBe(false);
  });

  it('shows the error as an alert with an inline Retry that asks for a sync', async () => {
    const w = mountPanel(status({ sync: { state: 'error', error: { kind: 'network_unavailable' } } }));
    const alert = test(w, 'account-sync-error');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toContain('Sync failed: no network.');
    expect(alert.text()).not.toContain('The network is unavailable');
    const retry = alert.get('[data-test="account-sync-retry"]');
    expect(retry.text()).toBe('Retry');
    await retry.trigger('click');
    expect(w.emitted('sync')).toHaveLength(1);
    expect(test(mountPanel(status()), 'account-sync-error').exists()).toBe(false);
  });
});

describe('AccountPanel permissions', () => {
  it('keeps a shorter scope disclosure next to the Enable button', async () => {
    const w = mountPanel(status());
    const disclosure = test(w, 'action-upgrade-disclosure');
    expect(disclosure.text()).toBe("Enable mailbox actions asks Google for its broad Gmail modify permission, which can also allow sending and deleting mail. Email OS only marks done, marks read and stars; it never sends or deletes.");
    const enable = test(w, 'enable-mailbox-actions');
    expect(enable.text()).toBe('Enable mailbox actions');
    // Disclosure first, then the button.
    expect(disclosure.element.compareDocumentPosition(enable.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await enable.trigger('click');
    expect(w.emitted('enableActions')).toHaveLength(1);
    expect(test(mountPanel(status(), { busy: 'enable-actions' }), 'enable-mailbox-actions').text()).toBe('Requesting permission…');
  });

  it('upgrading: a finish-in-browser status with Cancel permission request as the main button', async () => {
    const w = mountPanel(status({ mutationAccess: 'upgrading' }));
    expect(test(w, 'action-upgrading').attributes('role')).toBe('status');
    expect(test(w, 'action-upgrading').text()).toContain('Finish sign-in in your browser');
    expect(test(w, 'action-upgrading').text()).toContain('Cached mail stays readable');
    expect(test(w, 'enable-mailbox-actions').exists()).toBe(false);
    const cancel = test(w, 'cancel-action-upgrade');
    expect(cancel.text()).toBe('Cancel permission request');
    expect(cancel.classes()).toContain('account-primary');
    await cancel.trigger('click');
    expect(w.emitted('cancelUpgrade')).toHaveLength(1);
    expect(test(mountPanel(status({ mutationAccess: 'upgrading' }), { busy: 'cancel-upgrade' }), 'cancel-action-upgrade').text()).toBe('Canceling permission request…');
  });

  it('enabled says so once; disconnected shows no scope disclosure or button', () => {
    expect(test(mountPanel(status({ mutationAccess: 'enabled' })), 'actions-enabled').text()).toBe('Mailbox actions are enabled.');
    const w = mountPanel(status({ connection: 'disconnected', account: null }));
    expect(test(w, 'enable-mailbox-actions').exists()).toBe(false);
    expect(test(w, 'action-upgrade-disclosure').exists()).toBe(false);
  });
});

describe('AccountPanel disconnect confirmation', () => {
  it('keeps the warning out of the DOM until asked, then reveals it in place with two choices', async () => {
    const w = mountPanel(status());
    expect(test(w, 'disconnect-warning').exists()).toBe(false);
    expect(test(w, 'account-disconnect-confirm').exists()).toBe(false);
    const ask = test(w, 'account-disconnect');
    expect(ask.text()).toBe('Disconnect…');
    expect(ask.classes()).toContain('drawer-ghost');
    await ask.trigger('click');
    expect(w.emitted('disconnect')).toBeUndefined();
    expect(test(w, 'disconnect-warning').text()).toBe(
      "Removes pending actions and the mail cache from this device. Local drafts stay and return if you reconnect the same account. Confirmed Gmail changes are not undone and Google's grant is not revoked.",
    );
    expect(test(w, 'account-disconnect-confirm').text()).toBe('Disconnect');
    expect(test(w, 'account-disconnect-cancel').text()).toBe('Keep account');
    // Focus moves to the safe choice.
    expect(document.activeElement).toBe(test(w, 'account-disconnect-cancel').element);
  });

  it('tells the two chips apart: Disconnect is the destructive one, Keep account the default', async () => {
    const w = mountPanel(status());
    await test(w, 'account-disconnect').trigger('click');
    expect(test(w, 'account-disconnect-confirm').classes()).toContain('account-destructive');
    expect(test(w, 'account-disconnect-cancel').classes()).toContain('account-primary');
    expect(test(w, 'account-disconnect-cancel').classes()).not.toContain('account-destructive');
    expect(test(w, 'account-disconnect-confirm').classes()).not.toContain('account-primary');
  });

  it('Keep account closes the confirm and returns focus to Disconnect…', async () => {
    const w = mountPanel(status());
    await test(w, 'account-disconnect').trigger('click');
    await test(w, 'account-disconnect-cancel').trigger('click');
    await flushPromises();
    expect(test(w, 'disconnect-warning').exists()).toBe(false);
    expect(w.emitted('disconnect')).toBeUndefined();
    expect(document.activeElement).toBe(test(w, 'account-disconnect').element);
  });

  it('Esc cancels the confirm without reaching the drawer handler, and ignores IME composition', async () => {
    const w = mountPanel(status());
    let reached = 0;
    const onWindow = (): void => { reached += 1; };
    window.addEventListener('keydown', onWindow);
    try {
      await test(w, 'account-disconnect').trigger('click');
      const ime = createKeyEvent('Escape', { bubbles: true, cancelable: true, isComposing: true });
      test(w, 'account-disconnect-cancel').element.dispatchEvent(ime);
      await flushPromises();
      expect(test(w, 'disconnect-warning').exists()).toBe(true);
      const esc = createKeyEvent('Escape', { bubbles: true, cancelable: true });
      test(w, 'account-disconnect-cancel').element.dispatchEvent(esc);
      await flushPromises();
      expect(test(w, 'disconnect-warning').exists()).toBe(false);
      expect(esc.defaultPrevented).toBe(true);
      expect(reached).toBe(1); // only the IME key; the real Escape was consumed
      expect(document.activeElement).toBe(test(w, 'account-disconnect').element);
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('Disconnect confirms exactly once; it is disabled while another action runs', async () => {
    const w = mountPanel(status());
    await test(w, 'account-disconnect').trigger('click');
    await test(w, 'account-disconnect-confirm').trigger('click');
    expect(w.emitted('disconnect')).toHaveLength(1);
    const busy = mountPanel(status(), { busy: 'sync' });
    expect(test(busy, 'account-disconnect').attributes('disabled')).toBeDefined();
  });

  it('resets when the account goes away, and cancelling a sign-in stays one click', async () => {
    const w = mountPanel(status());
    await test(w, 'account-disconnect').trigger('click');
    await w.setProps({ status: status({ connection: 'disconnected', account: null }) });
    expect(test(w, 'disconnect-warning').exists()).toBe(false);
    expect(test(w, 'account-disconnect').exists()).toBe(false);

    const signing = mountPanel(status({ connection: 'authenticating', account: null }));
    expect(test(signing, 'account-disconnect').text()).toBe('Cancel sign-in');
    await test(signing, 'account-disconnect').trigger('click');
    expect(signing.emitted('disconnect')).toHaveLength(1);
    expect(test(signing, 'disconnect-warning').exists()).toBe(false);
  });

  it('still allows a local disconnect (with confirm) for a retained account that is not connected', async () => {
    for (const connection of ['disconnected', 'not_configured'] as const) {
      const w = mountPanel(status({ connection, account: { accountId: 'a', emailAddress: 'retained@example.test' } }));
      await test(w, 'account-disconnect').trigger('click');
      expect(test(w, 'disconnect-warning').exists()).toBe(true);
      await test(w, 'account-disconnect-confirm').trigger('click');
      expect(w.emitted('disconnect')).toHaveLength(1);
    }
  });
});

describe('AccountPanel action error', () => {
  it('is an alert with the plain sentence, in the same coral class family as the sync error', () => {
    const w = mountPanel(status(), { actionError: { kind: 'permission_required' } as MailError });
    const err = test(w, 'account-action-error');
    expect(err.attributes('role')).toBe('alert');
    expect(err.text()).toContain('remains read-only');
    // Source-level pin (jsdom does not resolve the stylesheet): the failure tone is Coral Fault, not Amber Notice.
    expect(css).not.toMatch(/\.account-action-error\s*\{[^}]*color: var\(--warning\)/s);
    expect(css).toMatch(/\.account-sync-error,\s*\.account-action-error\s*\{[^}]*color: var\(--danger\)/s);
  });
});

describe('AccountPanel destructive confirm (CSS source)', () => {
  it('gives Disconnect a Coral Fault text and border cue; Keep account stays the focused default', () => {
    const rule = css.match(/\.account-confirm \.account-destructive\s*\{([^}]*)\}/)![1]!;
    expect(rule).toMatch(/color:\s*var\(--danger\)/);
    expect(rule).toMatch(/border-color:\s*var\(--danger\)/);
    expect(css).toMatch(/\.account-confirm \.account-primary\s*\{[^}]*background:\s*var\(--focus-fill\)/s);
  });
});
