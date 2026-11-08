import { describe, expect, it } from 'vitest';
import {
  INBOX_EMPTY_RECOVERABLE,
  INBOX_EMPTY_READ_ONLY,
  accountNotice,
  describeMailError,
  inboxEmptyState,
} from '../src/lib/account-status';
import type { AccountStatus, ConnectionState, MailError, MutationAccess, SyncInfo } from '../src/lib/ipc/client';

function status(patch: {
  mode?: AccountStatus['mode'];
  connection?: ConnectionState;
  mutationAccess?: MutationAccess;
  sync?: Partial<SyncInfo>;
  account?: AccountStatus['account'];
} = {}): AccountStatus {
  return {
    mode: patch.mode ?? 'gmail',
    connection: patch.connection ?? 'connected',
    account: patch.account === undefined ? { accountId: 'gmail-account', emailAddress: 'operator@example.test' } : patch.account,
    mutationAccess: patch.mutationAccess ?? 'read_only',
    sync: {
      state: 'idle', lastSyncedAt: null, error: null, cachedConversations: 0,
      initialSyncComplete: true, coverageLimit: 100, ...patch.sync,
    },
  };
}

describe('describeMailError', () => {
  it('keeps the plain sentences and ends the unknown fallback with a capital and a period', () => {
    expect(describeMailError({ kind: 'network_unavailable' })).toBe('The network is unavailable.');
    expect(describeMailError({ kind: 'not_configured' })).toBe('Gmail is not configured on this device.');
    expect(describeMailError({ kind: 'storage_unavailable' })).toBe('Local storage is unavailable.');
    expect(describeMailError({ kind: 'draft_conflict', currentRevision: 2 } as MailError)).toBe('Unknown error.');
  });
});

describe('accountNotice', () => {
  it('is null in fixture mode, without a status, and when connected and idle', () => {
    expect(accountNotice(null)).toBeNull();
    expect(accountNotice(status({ mode: 'fixture' }))).toBeNull();
    expect(accountNotice(status({ mode: 'fixture', connection: 'disconnected' }))).toBeNull();
    expect(accountNotice(status())).toBeNull();
  });

  it.each([
    ['not_configured', 'Gmail not configured', null, 'neutral'],
    ['disconnected', 'Not connected', 'connect', 'neutral'],
    ['auth_required', 'Sign-in expired', 'connect', 'warning'],
    ['authenticating', 'Finish sign-in in your browser', 'cancel', 'neutral'],
  ] as const)('maps the %s connection to one note', (connection, text, action, tone) => {
    const notice = accountNotice(status({ connection }));
    expect(notice).toMatchObject({ kind: connection, text, action, tone });
    expect(notice!.title.length).toBeGreaterThan(text.length);
  });

  it('labels the connect action by state and keeps the cached-reading fact in the title only', () => {
    expect(accountNotice(status({ connection: 'disconnected' }))!.actionLabel).toBe('Connect');
    const expired = accountNotice(status({ connection: 'auth_required', sync: { cachedConversations: 18 } }))!;
    expect(expired.actionLabel).toBe('Sign in');
    expect(expired.title).toContain('Cached mail stays readable; new mail will not sync until you sign in.');
    expect(expired.text).not.toContain('Cached');
    expect(accountNotice(status({ connection: 'authenticating' }))!.actionLabel).toBe('Cancel');
  });

  it('does not claim actions are off (actions are not gated by the connection)', () => {
    for (const connection of ['disconnected', 'auth_required', 'authenticating', 'not_configured'] as const) {
      const notice = accountNotice(status({ connection }))!;
      expect(`${notice.text} ${notice.title}`.toLowerCase()).not.toContain('actions off');
      expect(`${notice.text} ${notice.title}`.toLowerCase()).not.toContain('disabled');
    }
  });

  it('shows sync progress with a cached count only during the first sync', () => {
    expect(accountNotice(status({ sync: { state: 'syncing', cachedConversations: 12, initialSyncComplete: false } }))).toMatchObject({
      kind: 'syncing', text: 'Syncing first mail · 12 cached', action: null,
    });
    expect(accountNotice(status({ sync: { state: 'syncing', cachedConversations: 12 } }))).toMatchObject({
      kind: 'syncing', text: 'Syncing…', action: null,
    });
    // The title is the stable announcement: the ticking count never changes it.
    const a = accountNotice(status({ sync: { state: 'syncing', cachedConversations: 3, initialSyncComplete: false } }))!;
    const b = accountNotice(status({ sync: { state: 'syncing', cachedConversations: 4, initialSyncComplete: false } }))!;
    expect(a.title).toBe(b.title);
  });

  it('says Offline only for network_unavailable and Sync failed for every other error', () => {
    const offline = accountNotice(status({ sync: { state: 'error', error: { kind: 'network_unavailable' } } }))!;
    expect(offline).toMatchObject({ kind: 'offline', text: 'Offline', action: 'sync', actionLabel: 'Retry', tone: 'warning' });
    expect(offline.title).toContain('The network is unavailable.');
    for (const error of [{ kind: 'provider_unavailable' }, { kind: 'rate_limited' }, { kind: 'storage_unavailable' }] as MailError[]) {
      const failed = accountNotice(status({ sync: { state: 'error', error } }))!;
      expect(failed).toMatchObject({ kind: 'sync_failed', text: 'Sync failed', action: 'sync', actionLabel: 'Retry', tone: 'danger' });
      expect(failed.title).toContain(describeMailError(error));
    }
    // A sync error with no typed cause is still a failure, never relabelled.
    expect(accountNotice(status({ sync: { state: 'error', error: null } }))).toMatchObject({ kind: 'sync_failed', text: 'Sync failed' });
  });

  it('lets a connection problem win over a sync state', () => {
    expect(accountNotice(status({ connection: 'auth_required', sync: { state: 'error', error: { kind: 'auth_required' } } }))!.kind).toBe('auth_required');
    expect(accountNotice(status({ connection: 'disconnected', sync: { state: 'syncing' } }))!.kind).toBe('disconnected');
  });
});

describe('inboxEmptyState', () => {
  it('returns null in fixture mode and without a status so the caller keeps its own wording', () => {
    expect(inboxEmptyState(null)).toBeNull();
    expect(inboxEmptyState(status({ mode: 'fixture' }))).toBeNull();
  });

  it.each([
    ['not_configured', 'Gmail is not configured on this device.', 'account', 'Account'],
    ['disconnected', 'Not connected.', 'connect', 'Connect Gmail'],
    ['auth_required', 'Sign-in expired.', 'connect', 'Sign in again'],
    ['authenticating', 'Finish sign-in in your browser.', 'cancel', 'Cancel'],
  ] as const)('explains the %s connection with its own action', (connection, text, action, actionLabel) => {
    expect(inboxEmptyState(status({ connection }))).toMatchObject({ kind: connection, text, action, actionLabel });
  });

  it('never offers Connect for a device that is not configured', () => {
    expect(inboxEmptyState(status({ connection: 'not_configured' }))!.action).toBe('account');
  });

  it('distinguishes first sync running, failed, unfinished and genuinely empty', () => {
    expect(inboxEmptyState(status({ sync: { state: 'syncing', cachedConversations: 7, initialSyncComplete: false } }))).toMatchObject({
      kind: 'syncing', text: 'Syncing first mail… 7 cached.', action: null,
    });
    expect(inboxEmptyState(status({ sync: { state: 'error', error: { kind: 'network_unavailable' }, initialSyncComplete: false } }))).toMatchObject({
      kind: 'sync_error', text: 'Sync failed: The network is unavailable.', action: 'sync', actionLabel: 'Retry',
    });
    expect(inboxEmptyState(status({ sync: { state: 'idle', initialSyncComplete: false } }))).toMatchObject({
      kind: 'sync_unfinished', text: 'Initial sync has not finished.', action: 'sync', actionLabel: 'Sync now',
    });
    expect(inboxEmptyState(status({ sync: { state: 'syncing', initialSyncComplete: true } }))!.kind).toBe('empty');
  });

  it('shows the real empty text only for a connected, synced inbox, and only claims Activity recovery where it exists', () => {
    expect(inboxEmptyState(status({ mutationAccess: 'enabled' }))).toMatchObject({
      kind: 'empty', text: INBOX_EMPTY_RECOVERABLE, action: null,
    });
    expect(INBOX_EMPTY_RECOVERABLE).toBe('No conversations are currently in the inbox. Archived conversations stay recoverable from Activity.');
    for (const mutationAccess of ['read_only', 'upgrading'] as const) {
      expect(inboxEmptyState(status({ mutationAccess }))).toMatchObject({ kind: 'empty', text: INBOX_EMPTY_READ_ONLY });
    }
    expect(INBOX_EMPTY_READ_ONLY).toBe('No conversations in the cached inbox.');
  });
});
