/**
 * `useMailboxGroups` in isolation: the session, command fence and account
 * readers are plain arguments, so the explicit session dependency can be moved
 * by the test itself. A response captured before the session moved (account
 * change, disconnect, reconnect) or after the owner detached must never publish.
 * Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { effectScope, ref } from 'vue';
import { useMailboxGroups } from '../../src/composables/useMailboxGroups';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';
import type { CommandFence } from '../../src/composables/mailbox-session';
import type { ConversationRef, MailClient, OperationGroupPage, OperationGroupStatus } from '../../src/lib/ipc/client';
import { deferred, flushMacrotasks } from '../helpers';

const target: ConversationRef = { accountId: 'acct', conversationId: 'conv-01' };
const summary = {
  groupId: 'group-1', requestId: 'req-1', kind: 'archive' as const, requestedArchived: true,
  acceptedAt: '2026-01-01T00:00:00Z', members: [target], undone: false,
};
const status: OperationGroupStatus = {
  group: { ...summary, accountId: 'acct', members: [{ ordinal: 0, conversation: target, operationId: 'op-1', rejection: null }] },
  members: [],
  undo: { available: false, reason: 'expired', undoableUntil: null },
};

function setup(overrides: Partial<MailClient> = {}) {
  const client = { ...createBrowserFakeMailClient(), ...overrides } as MailClient;
  const session = { generation: 0, detached: false };
  let token = 0;
  const commands: CommandFence = { next: () => ++token, current: () => token };
  const scope = effectScope();
  const groups = scope.run(() => useMailboxGroups({
    client, session, commands,
    accountId: () => 'acct',
    mode: () => 'gmail',
    savedTargetAvailable: () => true,
    mutationsAllowed: () => true,
    refresh: async () => undefined,
    repointLastAction: () => undefined,
    lastAction: ref(null),
    lastCommandError: ref(null),
    commandInFlight: ref(false),
    inFlightCommandRef: ref(null),
    activity: ref([]),
  }))!;
  return { groups, session, stop: () => scope.stop() };
}

describe('useMailboxGroups session fences', () => {
  it('drops a group-history page that lands after the session generation moved', async () => {
    const gate = deferred<OperationGroupPage>();
    const { groups, session, stop } = setup({ listOperationGroups: () => gate.promise });
    const pending = groups.refreshGroups();
    session.generation += 1; // account change / disconnect
    gate.resolve({ groups: [summary], nextCursor: null });
    await pending;
    expect(groups.recentGroups.value).toEqual([]);
    stop();
  });

  it('drops a group-detail read after the surfaces were cleared for an invalidated session', async () => {
    const gate = deferred<OperationGroupStatus | null>();
    const { groups, session, stop } = setup({ getOperationGroup: () => gate.promise });
    const pending = groups.openGroupDetail('req-1');
    session.generation += 1;
    groups.clearGroupSurfaces();
    gate.resolve(status);
    await pending;
    expect(groups.groupDetail.value).toBeNull();
    expect(groups.groupDetailError.value).toBeNull();
    stop();
  });

  it('drops a status read for the notice slot when the session moved, and keeps the slot untouched', async () => {
    const gate = deferred<OperationGroupStatus | null>();
    const { groups, session, stop } = setup({ getOperationGroup: () => gate.promise });
    groups.lastGroup.value = {
      requestId: 'req-1', accountId: 'acct', kind: 'archive', requestedArchived: true, members: [target],
      state: 'accepted', receipt: status.group, status: null, statusError: false, undone: null, hadWindow: false,
      originalCommand: { accountId: 'acct', members: [target], archived: true, requestId: 'req-1' },
    };
    groups.afterAuthoritativeRefresh();
    await flushMacrotasks(1);
    session.generation += 1;
    gate.resolve(status);
    await flushMacrotasks(2);
    expect(groups.lastGroup.value?.status).toBeNull();
    expect(groups.lastGroup.value?.statusError).toBe(false);
    stop();
  });

  it('publishes nothing once the owner is detached', async () => {
    const gate = deferred<OperationGroupPage>();
    const { groups, session, stop } = setup({ listOperationGroups: () => gate.promise });
    const pending = groups.refreshGroups();
    session.detached = true;
    gate.resolve({ groups: [summary], nextCursor: null });
    await pending;
    expect(groups.recentGroups.value).toEqual([]);
    stop();
  });

  it('rejects a group dispatch on an empty member list without touching the transport', async () => {
    let calls = 0;
    const { groups, stop } = setup({ setArchivedGroup: () => { calls += 1; return Promise.reject(new Error('unreachable')); } });
    expect(await groups.setArchivedGroup([], true)).toBe(false);
    expect(calls).toBe(0);
    expect(groups.lastGroup.value).toBeNull();
    stop();
  });
});
