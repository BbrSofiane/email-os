/**
 * Account lifecycle for the mailbox: authoritative account/mode status, connect,
 * disconnect, sync, and the opt-in mailbox-actions upgrade (enable and cancel).
 *
 * Invalidation is explicit. Every status read is fenced by its own request token
 * and by `session.detached`; a late response from an older read, or one that
 * lands after the owner is disposed, never publishes. The two moments that end
 * the previous account's session are surfaced to the owner as callbacks rather
 * than reached into: `onAccountChanged` (a status read observed a different
 * account identity) and `onDisconnected` (core confirmed the disconnect). The
 * owner resets its list, reader, group and selection state and bumps its
 * session generation inside them, before this module publishes the new status.
 * There is no module-level mutable state and nothing closes over the parent.
 */
import { computed, ref, type Ref } from 'vue';
import type { AccountStatus, MailClient, MailError, MailMode } from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';
import type { MailboxSession } from './mailbox-session';

export type AccountState = 'loading' | 'ready' | 'error';
export type AccountAction = 'connect' | 'disconnect' | 'sync' | 'enable-actions' | 'cancel-upgrade';

export interface MailboxAccountDeps {
  client: MailClient;
  session: Pick<MailboxSession, 'detached'>;
  /** Explicit navigation supersedes a search still awaiting cancellation. */
  supersedeNavigation: () => void;
  /** A status read observed a different account identity. */
  onAccountChanged: () => void;
  /** Core confirmed the disconnect; reset surfaces before the status is cleared. */
  onDisconnected: () => void;
  /** Authoritative list/status/detail refresh. */
  refresh: () => Promise<void>;
  lastCommandError: Ref<MailError | null>;
}

export function useMailboxAccount({
  client, session, supersedeNavigation, onAccountChanged, onDisconnected, refresh, lastCommandError,
}: MailboxAccountDeps) {
  const accountStatus = ref<AccountStatus | null>(null);
  const accountState = ref<AccountState>('loading');
  const accountError = ref<MailError | null>(null);
  const accountBusy = ref<AccountAction | null>(null);
  let statusToken = 0;

  /** Status failures never reject: the UI gate renders them and stays fail-closed. */
  async function refreshStatus(token: number): Promise<void> {
    try {
      const status = await client.getAccountStatus();
      if (session.detached || token !== statusToken) return;
      const oldAccount = accountStatus.value?.account?.accountId;
      if (oldAccount && oldAccount !== status.account?.accountId) {
        onAccountChanged();
      }
      accountStatus.value = status;
      accountError.value = null;
      accountState.value = 'ready';
    } catch (raw) {
      if (session.detached || token !== statusToken) return;
      accountError.value = toMailError(raw);
      accountState.value = 'error';
    }
  }

  async function connectAccount(): Promise<void> {
    if (accountBusy.value) return;
    supersedeNavigation();
    accountBusy.value = 'connect';
    // Mirror core: connecting flips the connection optimistically; a failure is
    // corrected by the status refetch below.
    if (accountStatus.value) {
      accountStatus.value = { ...accountStatus.value, connection: 'authenticating' };
    }
    try {
      await client.connectAccount();
      if (!session.detached) await refresh();
    } catch (raw) {
      if (!session.detached) {
        lastCommandError.value = toMailError(raw);
        await refreshStatus(++statusToken);
      }
    } finally {
      if (!session.detached) accountBusy.value = null;
    }
  }

  async function disconnectAccount(): Promise<void> {
    if (accountBusy.value) return;
    supersedeNavigation();
    accountBusy.value = 'disconnect';
    try {
      // Resolves only after core deleted credentials and cleared local data.
      await client.disconnectAccount();
    } catch (raw) {
      if (!session.detached) lastCommandError.value = toMailError(raw);
      return;
    } finally {
      if (!session.detached) accountBusy.value = null;
    }
    if (session.detached) return;
    onDisconnected();
    if (accountStatus.value) {
      const sync = accountStatus.value.sync;
      accountStatus.value = {
        ...accountStatus.value,
        connection: 'disconnected',
        account: null,
        sync: { ...sync, state: 'idle', error: null, lastSyncedAt: null, cachedConversations: 0, initialSyncComplete: false },
      };
    }
    await refresh();
  }

  async function requestSync(): Promise<void> {
    if (accountBusy.value) return;
    accountBusy.value = 'sync';
    try {
      // Acceptance, not completion; progress arrives via status changes/events.
      await client.requestSync();
      if (!session.detached) await refresh();
    } catch (raw) {
      if (!session.detached) lastCommandError.value = toMailError(raw);
    } finally {
      if (!session.detached) accountBusy.value = null;
    }
  }

  async function enableMailboxActions(): Promise<void> {
    if (accountBusy.value || accountState.value !== 'ready' || accountStatus.value?.mode !== 'gmail' || accountStatus.value.mutationAccess === 'enabled') return;
    accountBusy.value = 'enable-actions';
    lastCommandError.value = null;
    try {
      // This command only accepts/enqueues an explicit OAuth upgrade. Enabled state
      // comes exclusively from a later authoritative account-status read.
      await client.enableMailboxActions();
      if (!session.detached) await refreshStatus(++statusToken);
    } catch (raw) {
      if (!session.detached) {
        lastCommandError.value = toMailError(raw);
        await refreshStatus(++statusToken);
      }
    } finally {
      if (!session.detached) accountBusy.value = null;
    }
  }

  async function cancelMailboxActionUpgrade(): Promise<void> {
    if (accountBusy.value || accountState.value !== 'ready' || accountStatus.value?.mutationAccess !== 'upgrading') return;
    accountBusy.value = 'cancel-upgrade';
    lastCommandError.value = null;
    try {
      await client.cancelMailboxActionUpgrade();
      if (!session.detached) await refreshStatus(++statusToken);
    } catch (raw) {
      if (!session.detached) {
        lastCommandError.value = toMailError(raw);
        await refreshStatus(++statusToken);
      }
    } finally {
      if (!session.detached) accountBusy.value = null;
    }
  }

  /** Claims the next status read; an older in-flight read can no longer publish. */
  function refreshAccountStatus(): Promise<void> {
    return refreshStatus(++statusToken);
  }

  const mode = computed<MailMode | null>(() => accountStatus.value?.mode ?? null);
  const isGmail = computed(() => mode.value === 'gmail');

  return {
    accountStatus, accountState, accountError, accountBusy, mode, isGmail,
    refreshAccountStatus, connectAccount, disconnectAccount, requestSync,
    enableMailboxActions, cancelMailboxActionUpgrade,
  };
}
