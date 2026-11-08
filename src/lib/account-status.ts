/**
 * Pure account-state wording shared by the Account drawer, the header status
 * note and the empty inbox line. Everything derives from `AccountStatus`
 * (connection, sync state and error, initial sync, cached count); nothing here
 * invents a state, and pending, failed and unknown stay distinct.
 *
 * Actions are never gated by the connection (a Gmail command with an expired
 * sign-in still runs and fails at the provider), so no text here says actions
 * are off. The one standing fact worth saying is about reading: cached mail
 * stays readable.
 */
import type { AccountStatus, MailError } from './ipc/client';

/** One plain sentence per typed error. */
export function describeMailError(error: MailError): string {
  switch (error.kind) {
    case 'not_configured':
      return 'Gmail is not configured on this device.';
    case 'auth_required':
      return 'Sign-in is required to continue syncing.';
    case 'auth_cancelled':
      return 'Sign-in was cancelled.';
    case 'auth_failed':
      return 'Sign-in failed.';
    case 'secrets_unavailable':
      return 'Secure credential storage is unavailable.';
    case 'network_unavailable':
      return 'The network is unavailable.';
    case 'rate_limited':
      return 'The provider is rate limiting; retrying with backoff.';
    case 'provider_unavailable':
      return 'The mail provider is temporarily unavailable.';
    case 'invalid_provider_response':
      return 'The provider returned an unexpected response.';
    case 'busy':
      return 'A sync is already in progress.';
    case 'permission_required':
      return 'Google did not grant mailbox-action permission; the account remains read-only.';
    case 'provider_rejected':
      return 'The provider rejected the mailbox action.';
    case 'outcome_unknown':
      return 'The provider outcome is unknown; review Activity before retrying.';
    case 'read_only':
      return 'Gmail is read-only; this action is unavailable.';
    case 'storage_unavailable':
      return 'Local storage is unavailable.';
    case 'not_found':
      return 'Not found.';
    case 'invalid_request':
      return 'Invalid request.';
    case 'request_id_conflict':
      return 'Conflicting request.';
    case 'profile_in_use':
      return 'The profile is in use by another window.';
    default:
      return 'Unknown error.';
  }
}

export type AccountNoticeKind =
  | 'not_configured' | 'disconnected' | 'auth_required' | 'authenticating'
  | 'syncing' | 'offline' | 'sync_failed';
export type AccountNoticeAction = 'connect' | 'sync' | 'cancel';

/** The header note: terse visible text, the full fact in `title`. */
export interface AccountNotice {
  kind: AccountNoticeKind;
  /** Visible words. */
  text: string;
  /**
   * Self-contained sentence(s): the hover title and the visually hidden text.
   * It never contains a ticking count, so it can be announced once.
   */
  title: string;
  action: AccountNoticeAction | null;
  actionLabel: string;
  tone: 'neutral' | 'warning' | 'danger';
}

/** Connection states that replace the older read-only hint in the header. */
export const CONNECTION_NOTICE_KINDS: readonly AccountNoticeKind[] = ['not_configured', 'disconnected', 'auth_required', 'authenticating'];

/** Null in fixture mode, without a status, and while connected and idle. */
export function accountNotice(status: AccountStatus | null): AccountNotice | null {
  if (!status || status.mode !== 'gmail') return null;
  const { sync } = status;
  const cached = sync.cachedConversations;
  switch (status.connection) {
    case 'not_configured':
      return {
        kind: 'not_configured', text: 'Gmail not configured', action: null, actionLabel: '', tone: 'neutral',
        title: 'Gmail is not configured on this device. Connecting is unavailable.',
      };
    case 'disconnected':
      return {
        kind: 'disconnected', text: 'Not connected', action: 'connect', actionLabel: 'Connect', tone: 'neutral',
        title: cached > 0
          ? 'Not connected to Gmail. Cached mail stays readable; new mail will not sync until you connect.'
          : 'Not connected to Gmail. Connect to load and sync mail.',
      };
    case 'auth_required':
      return {
        kind: 'auth_required', text: 'Sign-in expired', action: 'connect', actionLabel: 'Sign in', tone: 'warning',
        title: 'Sign-in expired. Cached mail stays readable; new mail will not sync until you sign in.',
      };
    case 'authenticating':
      return {
        kind: 'authenticating', text: 'Finish sign-in in your browser', action: 'cancel', actionLabel: 'Cancel', tone: 'neutral',
        title: 'Gmail sign-in is waiting for your browser. Cancel stops it.',
      };
    case 'connected':
      break;
  }
  if (sync.state === 'error') {
    const firstSync = sync.initialSyncComplete ? '' : ` · ${cached} cached`;
    const cause = sync.error ? `${describeMailError(sync.error)} ` : '';
    if (sync.error?.kind === 'network_unavailable') {
      return {
        kind: 'offline', text: `Offline${firstSync}`, action: 'sync', actionLabel: 'Retry', tone: 'warning',
        title: `Offline. ${cause}Cached mail stays readable; new mail has not synced.`,
      };
    }
    return {
      kind: 'sync_failed', text: `Sync failed${firstSync}`, action: 'sync', actionLabel: 'Retry', tone: 'danger',
      title: `Sync failed. ${cause}Cached mail stays readable; new mail has not synced.`,
    };
  }
  if (sync.state === 'syncing') {
    return sync.initialSyncComplete
      ? { kind: 'syncing', text: 'Syncing…', title: 'Syncing mail. Cached mail stays readable.', action: null, actionLabel: '', tone: 'neutral' }
      : { kind: 'syncing', text: `Syncing first mail · ${cached} cached`, title: 'Syncing first mail. Cached mail stays readable.', action: null, actionLabel: '', tone: 'neutral' };
  }
  return null;
}

export const INBOX_EMPTY_RECOVERABLE = 'No conversations are currently in the inbox. Archived conversations stay recoverable from Activity.';
/** Gmail without mailbox actions: Activity offers no Mark not done there, so it is not promised. */
export const INBOX_EMPTY_READ_ONLY = 'No conversations in the cached inbox.';

export type InboxEmptyKind =
  | 'not_configured' | 'disconnected' | 'auth_required' | 'authenticating'
  | 'syncing' | 'sync_error' | 'sync_unfinished' | 'empty';
export type InboxEmptyAction = 'connect' | 'sync' | 'cancel' | 'account';

export interface InboxEmpty {
  kind: InboxEmptyKind;
  text: string;
  action: InboxEmptyAction | null;
  actionLabel: string;
}

/**
 * What a plain, zero-row Gmail inbox really means. Null outside Gmail mode (the
 * caller keeps the fixture sentence). Only a connected, fully synced account
 * gets the real "empty" text.
 */
export function inboxEmptyState(status: AccountStatus | null): InboxEmpty | null {
  if (!status || status.mode !== 'gmail') return null;
  const { sync } = status;
  switch (status.connection) {
    case 'not_configured':
      return { kind: 'not_configured', text: 'Gmail is not configured on this device.', action: 'account', actionLabel: 'Account' };
    case 'disconnected':
      return { kind: 'disconnected', text: 'Not connected.', action: 'connect', actionLabel: 'Connect Gmail' };
    case 'auth_required':
      return { kind: 'auth_required', text: 'Sign-in expired.', action: 'connect', actionLabel: 'Sign in again' };
    case 'authenticating':
      return { kind: 'authenticating', text: 'Finish sign-in in your browser.', action: 'cancel', actionLabel: 'Cancel' };
    case 'connected':
      break;
  }
  if (sync.state === 'error') {
    const cause = sync.error ? describeMailError(sync.error) : 'Unknown error.';
    return { kind: 'sync_error', text: `Sync failed: ${cause}`, action: 'sync', actionLabel: 'Retry' };
  }
  if (!sync.initialSyncComplete) {
    return sync.state === 'syncing'
      ? { kind: 'syncing', text: `Syncing first mail… ${sync.cachedConversations} cached.`, action: null, actionLabel: '' }
      : { kind: 'sync_unfinished', text: 'Initial sync has not finished.', action: 'sync', actionLabel: 'Sync now' };
  }
  return {
    kind: 'empty',
    text: status.mutationAccess === 'enabled' ? INBOX_EMPTY_RECOVERABLE : INBOX_EMPTY_READ_ONLY,
    action: null,
    actionLabel: '',
  };
}
