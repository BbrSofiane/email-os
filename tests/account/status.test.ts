import { describe, expect, it } from 'vitest';
import {
  INBOX_EMPTY_RECOVERABLE,
  INBOX_EMPTY_READ_ONLY,
  accountNotice,
  describeMailError,
  describeSyncFailure,
  drawerShowsSameFailure,
  emptyLineOwnsStatus,
  headerNoteAnnounces,
  headerNoticeAction,
  inboxEmptyState,
  readOnlyHintShown,
  splitNoticeText,
} from '../../src/lib/account-status';
import type { AccountStatus, ConnectionState, MailError, MutationAccess, SyncInfo } from '../../src/lib/ipc/client';

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

describe('describeSyncFailure', () => {
  it('says the network cause in one form, "no network", and keeps the plain sentence for other causes', () => {
    expect(describeSyncFailure({ kind: 'network_unavailable' })).toBe('Sync failed: no network.');
    expect(describeSyncFailure({ kind: 'rate_limited' })).toBe('Sync failed: The provider is rate limiting; retrying with backoff.');
    // No typed cause: still a failure, with no invented cause.
    expect(describeSyncFailure(null)).toBe('Sync failed.');
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
    // One name per action, on every surface: Connect Gmail, Sign in again, Cancel sign-in.
    expect(accountNotice(status({ connection: 'disconnected' }))!.actionLabel).toBe('Connect Gmail');
    const expired = accountNotice(status({ connection: 'auth_required', sync: { cachedConversations: 18 } }))!;
    expect(expired.actionLabel).toBe('Sign in again');
    expect(expired.title).toContain('Cached mail stays readable; new mail will not sync until you sign in.');
    expect(expired.text).not.toContain('Cached');
    expect(accountNotice(status({ connection: 'authenticating' }))!.actionLabel).toBe('Cancel sign-in');
  });

  it('gives a not-configured device a title with a next step instead of "connecting is unavailable"', () => {
    const notice = accountNotice(status({ connection: 'not_configured' }))!;
    expect(notice.title).not.toMatch(/unavailable/i);
    expect(notice.title).toContain('Gmail is not configured on this device.');
    expect(notice.title).toContain('Open Account');
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

  it('says Sync failed everywhere; network_unavailable adds the cause "no network" and never says Offline', () => {
    const offline = accountNotice(status({ sync: { state: 'error', error: { kind: 'network_unavailable' } } }))!;
    expect(offline).toMatchObject({ kind: 'offline', text: 'Sync failed · no network', action: 'sync', actionLabel: 'Retry', tone: 'danger' });
    expect(offline.title).toBe('Sync failed: no network. Cached mail stays readable; new mail has not synced.');
    expect(`${offline.text} ${offline.title}`).not.toMatch(/offline/i);
    // The first sync keeps its cached count after the cause.
    expect(accountNotice(status({ sync: { state: 'error', error: { kind: 'network_unavailable' }, initialSyncComplete: false, cachedConversations: 4 } }))!.text)
      .toBe('Sync failed · no network · 4 cached');
  });

  it('shows a short visible cause for known sync errors and never relabels an unknown one', () => {
    const causes: Array<[MailError, string]> = [
      [{ kind: 'rate_limited' } as MailError, 'Sync failed · rate limited'],
      [{ kind: 'provider_unavailable' } as MailError, 'Sync failed · provider unavailable'],
      [{ kind: 'storage_unavailable' } as MailError, 'Sync failed · storage unavailable'],
    ];
    for (const [error, text] of causes) {
      const failed = accountNotice(status({ sync: { state: 'error', error } }))!;
      expect(failed).toMatchObject({ kind: 'sync_failed', text, action: 'sync', actionLabel: 'Retry', tone: 'danger' });
      expect(failed.title).toContain(describeMailError(error));
      expect(failed.title.startsWith('Sync failed: ')).toBe(true);
    }
    // No typed cause, or a kind with no short phrase: still a failure, with no invented cause.
    expect(accountNotice(status({ sync: { state: 'error', error: null } }))).toMatchObject({ kind: 'sync_failed', text: 'Sync failed' });
    expect(accountNotice(status({ sync: { state: 'error', error: { kind: 'busy' } as MailError } }))).toMatchObject({ kind: 'sync_failed', text: 'Sync failed' });
  });

  it('lets a connection problem win over a sync state', () => {
    expect(accountNotice(status({ connection: 'auth_required', sync: { state: 'error', error: { kind: 'auth_required' } } }))!.kind).toBe('auth_required');
    expect(accountNotice(status({ connection: 'disconnected', sync: { state: 'syncing' } }))!.kind).toBe('disconnected');
  });
});

describe('readOnlyHintShown', () => {
  it('shows the read-only hint only in Gmail mode without mailbox actions, and steps aside for any status note', () => {
    expect(readOnlyHintShown(status(), accountNotice(status()))).toBe(true);
    expect(readOnlyHintShown(status({ mutationAccess: 'upgrading' }), null)).toBe(true);
    expect(readOnlyHintShown(status({ mutationAccess: 'enabled' }), null)).toBe(false);
    expect(readOnlyHintShown(status({ mode: 'fixture' }), null)).toBe(false);
    expect(readOnlyHintShown(null, null)).toBe(false);
    // Connection and sync notes both replace it (header width: DESIGN.md gap 18).
    for (const patch of [
      { connection: 'disconnected' as const },
      { connection: 'auth_required' as const },
      { sync: { state: 'syncing' as const } },
      { sync: { state: 'error' as const, error: { kind: 'network_unavailable' } as MailError } },
    ]) {
      const s = status(patch);
      expect(accountNotice(s)).not.toBeNull();
      expect(readOnlyHintShown(s, accountNotice(s))).toBe(false);
    }
  });
});

describe('headerNoticeAction', () => {
  it('gives the header note its action, or a single Account link when not configured', () => {
    expect(headerNoticeAction(accountNotice(status({ connection: 'disconnected' })), false)).toEqual({ action: 'connect', label: 'Connect Gmail' });
    expect(headerNoticeAction(accountNotice(status({ sync: { state: 'error', error: { kind: 'rate_limited' } as MailError } })), false)).toEqual({ action: 'sync', label: 'Retry' });
    expect(headerNoticeAction(accountNotice(status({ connection: 'not_configured' })), false)).toEqual({ action: 'account', label: 'Account' });
    expect(headerNoticeAction(null, false)).toBeNull();
    expect(headerNoticeAction(accountNotice(status({ sync: { state: 'syncing' } })), false)).toBeNull();
  });

  it('leaves only words in the header while the empty inbox line carries the action', () => {
    for (const connection of ['disconnected', 'auth_required', 'authenticating', 'not_configured'] as const) {
      expect(headerNoticeAction(accountNotice(status({ connection })), true)).toBeNull();
    }
    expect(headerNoticeAction(accountNotice(status({ sync: { state: 'error', error: { kind: 'network_unavailable' } } })), true)).toBeNull();
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
    ['authenticating', 'Finish sign-in in your browser.', 'cancel', 'Cancel sign-in'],
  ] as const)('explains the %s connection with its own action', (connection, text, action, actionLabel) => {
    expect(inboxEmptyState(status({ connection }))).toMatchObject({ kind: connection, text, action, actionLabel });
  });

  it('adds the first-run hint only where Connect really is the action and the grant is a fresh read-only one', () => {
    expect(inboxEmptyState(status({ connection: 'disconnected' }))!.hint)
      .toBe("Opens Google sign-in in your browser. Starts read-only: Email OS can't change your mail until you enable mailbox actions in Account.");
    for (const connection of ['auth_required', 'authenticating'] as const) {
      expect(inboxEmptyState(status({ connection }))!.hint, connection).toBeUndefined();
    }
    expect(inboxEmptyState(status({ sync: { state: 'error', error: { kind: 'network_unavailable' } } }))!.hint).toBeUndefined();
  });

  it('never offers Connect for a device that is not configured, and says the next step', () => {
    const notConfigured = inboxEmptyState(status({ connection: 'not_configured' }))!;
    expect(notConfigured.action).toBe('account');
    expect(notConfigured.hint).toBe('Add a Google client ID to the launch environment, then restart.');
  });

  it('distinguishes first sync running, failed, unfinished and genuinely empty', () => {
    expect(inboxEmptyState(status({ sync: { state: 'syncing', cachedConversations: 7, initialSyncComplete: false } }))).toMatchObject({
      kind: 'syncing', text: 'Syncing first mail… 7 cached.', action: null,
    });
    expect(inboxEmptyState(status({ sync: { state: 'error', error: { kind: 'network_unavailable' }, initialSyncComplete: false } }))).toMatchObject({
      kind: 'sync_error', text: 'Sync failed: no network.', action: 'sync', actionLabel: 'Retry',
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

describe('inboxEmptyState tone (the empty line echoes the header note tone)', () => {
  it('is danger for a failed sync, warning for an expired sign-in and neutral for everything else', () => {
    expect(inboxEmptyState(status({ sync: { state: 'error', error: { kind: 'network_unavailable' } as MailError } }))!.tone).toBe('danger');
    expect(inboxEmptyState(status({ sync: { state: 'error', error: null } }))!.tone).toBe('danger');
    expect(inboxEmptyState(status({ connection: 'auth_required' }))!.tone).toBe('warning');
    for (const patch of [
      { connection: 'not_configured' as const },
      { connection: 'disconnected' as const },
      { connection: 'authenticating' as const },
      { sync: { state: 'syncing' as const, initialSyncComplete: false } },
      { sync: { state: 'idle' as const, initialSyncComplete: false } },
      {},
    ]) {
      expect(inboxEmptyState(status(patch))!.tone, JSON.stringify(patch)).toBe('neutral');
    }
  });

  it('never disagrees with the header note: where both exist they have the same tone', () => {
    for (const patch of [
      { connection: 'not_configured' as const },
      { connection: 'disconnected' as const },
      { connection: 'auth_required' as const },
      { connection: 'authenticating' as const },
      { sync: { state: 'syncing' as const, initialSyncComplete: false } },
      { sync: { state: 'error' as const, error: { kind: 'rate_limited' } as MailError } },
      { sync: { state: 'error' as const, error: null } },
    ]) {
      const next = status(patch);
      expect(inboxEmptyState(next)!.tone, JSON.stringify(patch)).toBe(accountNotice(next)!.tone);
    }
  });
});

describe('splitNoticeText', () => {
  it('splits at the first separator so the lead can stay whole and the detail can yield', () => {
    expect(splitNoticeText('Sync failed · no network · 0 cached')).toEqual({ lead: 'Sync failed', detail: ' · no network · 0 cached' });
    expect(splitNoticeText('Syncing first mail · 7 cached')).toEqual({ lead: 'Syncing first mail', detail: ' · 7 cached' });
  });

  it('keeps a note with no separator as one lead', () => {
    expect(splitNoticeText('Sign-in expired')).toEqual({ lead: 'Sign-in expired', detail: '' });
    expect(splitNoticeText('Syncing…')).toEqual({ lead: 'Syncing…', detail: '' });
  });

  it('joins back to the visible text for every note', () => {
    const notice = accountNotice(status({ sync: { state: 'error', error: { kind: 'network_unavailable' } as MailError, initialSyncComplete: false } }))!;
    const { lead, detail } = splitNoticeText(notice.text);
    expect(lead + detail).toBe(notice.text);
    expect(lead).toBe('Sync failed');
  });
});

describe('emptyLineOwnsStatus', () => {
  it('gives the status sentence to the empty line in every zero-row state that has one', () => {
    for (const patch of [
      { connection: 'not_configured' as const },
      { connection: 'disconnected' as const },
      { connection: 'auth_required' as const },
      { connection: 'authenticating' as const },
      { sync: { state: 'syncing' as const, initialSyncComplete: false } },
      { sync: { state: 'error' as const, error: { kind: 'network_unavailable' } as MailError } },
    ]) {
      expect(emptyLineOwnsStatus(inboxEmptyState(status(patch)), true), JSON.stringify(patch)).toBe(true);
    }
  });

  it('does not, when the line is not showing or when it only says the inbox is empty (a later sync keeps its header note)', () => {
    expect(emptyLineOwnsStatus(inboxEmptyState(status({ connection: 'disconnected' })), false)).toBe(false);
    expect(emptyLineOwnsStatus(null, true)).toBe(false);
    const syncing = status({ sync: { state: 'syncing', initialSyncComplete: true } });
    expect(inboxEmptyState(syncing)!.kind).toBe('empty');
    expect(emptyLineOwnsStatus(inboxEmptyState(syncing), true)).toBe(false);
  });
});

describe('headerNoteAnnounces', () => {
  it('goes silent only while the Account drawer is open and shows the same sync failure as an alert', () => {
    const failed = status({ sync: { state: 'error', error: { kind: 'network_unavailable' } as MailError } });
    expect(headerNoteAnnounces(failed, false)).toBe(true);
    expect(headerNoteAnnounces(failed, true)).toBe(false);
    // No typed error means the drawer shows no alert, so the header keeps announcing.
    expect(headerNoteAnnounces(status({ sync: { state: 'error', error: null } }), true)).toBe(true);
    // A connection note is not repeated by the drawer's alert.
    expect(headerNoteAnnounces(status({ connection: 'auth_required' }), true)).toBe(true);
    expect(headerNoteAnnounces(status({ sync: { state: 'syncing' } }), true)).toBe(true);
    expect(headerNoteAnnounces(null, true)).toBe(true);
  });
});

describe('drawerShowsSameFailure', () => {
  it('is true only while the Account drawer is open and shows the typed sync failure as its alert', () => {
    const failed = status({ sync: { state: 'error', error: { kind: 'network_unavailable' } as MailError } });
    expect(drawerShowsSameFailure(failed, true)).toBe(true);
    expect(drawerShowsSameFailure(failed, false)).toBe(false);
    expect(drawerShowsSameFailure(status({ sync: { state: 'error', error: null } }), true)).toBe(false);
    expect(drawerShowsSameFailure(status({ connection: 'auth_required' }), true)).toBe(false);
    expect(drawerShowsSameFailure(status({ sync: { state: 'syncing' } }), true)).toBe(false);
    expect(drawerShowsSameFailure(status({ mode: 'fixture' }), true)).toBe(false);
    expect(drawerShowsSameFailure(null, true)).toBe(false);
  });

  it('is the exact opposite of the header note announcing', () => {
    for (const next of [
      status({ sync: { state: 'error', error: { kind: 'network_unavailable' } as MailError } }),
      status({ sync: { state: 'error', error: null } }),
      status({ connection: 'auth_required' }),
      status(),
      null,
    ]) {
      for (const open of [true, false]) expect(headerNoteAnnounces(next, open)).toBe(!drawerShowsSameFailure(next, open));
    }
  });
});
