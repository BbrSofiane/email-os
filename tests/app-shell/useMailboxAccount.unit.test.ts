/**
 * `useMailboxAccount` in isolation: the session, the navigation fence and the
 * reset callbacks are plain arguments, so ordering and stale-read fences are
 * asserted directly. Synthetic fixtures only.
 */
import { describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useMailboxAccount } from '../../src/composables/useMailboxAccount';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';
import type { AccountStatus, MailClient, MailError } from '../../src/lib/ipc/client';
import { deferred, useGmailMode } from '../helpers';

type StatusGate = ReturnType<typeof deferred<AccountStatus>>;

function setup(overrides: Partial<MailClient> = {}, prepare: (fake: ReturnType<typeof createBrowserFakeMailClient>) => void = () => undefined) {
  const fake = createBrowserFakeMailClient();
  prepare(fake);
  const client = { ...fake, ...overrides } as MailClient;
  const session = { detached: false };
  const events: string[] = [];
  const lastCommandError = ref<MailError | null>(null);
  const scope = effectScope();
  const account = scope.run(() => useMailboxAccount({
    client, session,
    supersedeNavigation: () => { events.push('supersede'); },
    onAccountChanged: () => { events.push('account-changed'); },
    onDisconnected: () => { events.push('disconnected'); },
    refresh: async () => { events.push('refresh'); },
    lastCommandError,
  }))!;
  return { account, fake, session, events, lastCommandError, stop: () => scope.stop() };
}

const gmail = (accountId: string): AccountStatus => ({
  mode: 'gmail', connection: 'connected', mutationAccess: 'enabled',
  account: { accountId, emailAddress: `${accountId}@example.test` },
  sync: { state: 'idle', lastSyncedAt: null, error: null, cachedConversations: 0, initialSyncComplete: true, coverageLimit: 0 },
} as unknown as AccountStatus);

describe('useMailboxAccount', () => {
  it('lets only the newest status read publish; an older response is dropped', async () => {
    const first: StatusGate = deferred<AccountStatus>();
    let call = 0;
    const { account, stop } = setup({ getAccountStatus: () => (++call === 1 ? first.promise : Promise.resolve(gmail('current'))) });
    const older = account.refreshAccountStatus();
    await account.refreshAccountStatus();
    first.resolve(gmail('stale'));
    await older;
    expect(account.accountStatus.value?.account?.accountId).toBe('current');
    stop();
  });

  it('drops a status read that lands after the owner detached', async () => {
    const gate: StatusGate = deferred<AccountStatus>();
    const { account, session, stop } = setup({ getAccountStatus: () => gate.promise });
    const pending = account.refreshAccountStatus();
    session.detached = true;
    gate.resolve(gmail('late'));
    await pending;
    expect(account.accountStatus.value).toBeNull();
    expect(account.accountState.value).toBe('loading');
    stop();
  });

  it('calls onAccountChanged before publishing a status with a different account identity', async () => {
    let which = 'first';
    const { account, events, stop } = setup({ getAccountStatus: () => Promise.resolve(gmail(which)) });
    await account.refreshAccountStatus();
    expect(events).toEqual([]); // first status: no previous identity
    await account.refreshAccountStatus();
    expect(events).toEqual([]); // same identity
    which = 'second';
    await account.refreshAccountStatus();
    expect(events).toEqual(['account-changed']);
    expect(account.accountStatus.value?.account?.accountId).toBe('second');
    stop();
  });

  it('surfaces a failed status read as a typed error state and never rejects', async () => {
    const { account, stop } = setup({ getAccountStatus: () => Promise.reject({ kind: 'storage_unavailable' }) });
    await expect(account.refreshAccountStatus()).resolves.toBeUndefined();
    expect(account.accountState.value).toBe('error');
    expect(account.accountError.value).toEqual({ kind: 'storage_unavailable' });
    stop();
  });

  it('disconnect supersedes navigation, resets the owner, clears the status, then refreshes', async () => {
    const { account, events, stop } = setup({}, (fake) => useGmailMode(fake));
    await account.refreshAccountStatus();
    await account.disconnectAccount();
    expect(events).toEqual(['supersede', 'disconnected', 'refresh']);
    expect(account.accountStatus.value?.connection).toBe('disconnected');
    expect(account.accountStatus.value?.account).toBeNull();
    expect(account.accountBusy.value).toBeNull();
    stop();
  });

  it('a failed disconnect keeps the account, reports the error and releases the busy flag without resetting', async () => {
    const { account, events, lastCommandError, stop } = setup({ disconnectAccount: () => Promise.reject({ kind: 'secrets_unavailable' }) }, (fake) => useGmailMode(fake));
    await account.refreshAccountStatus();
    await account.disconnectAccount();
    expect(events).toEqual(['supersede']);
    expect(lastCommandError.value).toEqual({ kind: 'secrets_unavailable' });
    expect(account.accountStatus.value?.connection).toBe('connected');
    expect(account.accountBusy.value).toBeNull();
    stop();
  });

  it('serialises account actions through one busy slot and ignores a second action', async () => {
    const gate = deferred<void>();
    const requestSync = vi.fn(() => gate.promise);
    const { account, stop } = setup({ requestSync }, (fake) => useGmailMode(fake));
    await account.refreshAccountStatus();
    const syncing = account.requestSync();
    expect(account.accountBusy.value).toBe('sync');
    await account.requestSync();
    await account.disconnectAccount();
    expect(requestSync).toHaveBeenCalledTimes(1);
    gate.resolve();
    await syncing;
    expect(account.accountBusy.value).toBeNull();
    stop();
  });

  it('enable-actions only starts for a Gmail account that is not already enabled, and re-reads status', async () => {
    const enable = vi.fn(() => Promise.resolve());
    const notEnabled = { ...gmail('acct'), mutationAccess: 'disabled' } as unknown as AccountStatus;
    let status: AccountStatus = notEnabled;
    const { account, stop } = setup({ enableMailboxActions: enable, getAccountStatus: () => Promise.resolve(status) });
    await account.enableMailboxActions(); // status not read yet: fails closed
    expect(enable).not.toHaveBeenCalled();
    await account.refreshAccountStatus();
    status = gmail('acct');
    await account.enableMailboxActions();
    expect(enable).toHaveBeenCalledTimes(1);
    expect(account.accountStatus.value?.mutationAccess).toBe('enabled');
    await account.enableMailboxActions(); // already enabled
    expect(enable).toHaveBeenCalledTimes(1);
    stop();
  });
});
