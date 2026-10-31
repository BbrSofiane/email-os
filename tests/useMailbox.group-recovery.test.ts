/**
 * UX-05 group recovery fixes (review pass): unresolved-acceptance intent is
 * never released by dismissal or by typed admission rejections, group
 * dispatch is fenced while a single mutation is in flight, group recovery
 * surfaces are session/account fenced and paginated, and stale status reads
 * never clobber a newer undo receipt. Synthetic only.
 */
import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useMailbox } from '../src/composables/useMailbox';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { deferred, fixtureRef, flushMacrotasks } from './helpers';
import type {
  MailClient,
  OperationGroupPage,
  OperationGroupStatus,
  OperationReceipt,
} from '../src/lib/ipc/client';

function scopeRun<T>(fn: () => T): { result: T; stop: () => void } {
  const scope = effectScope();
  const result = scope.run(fn) as T;
  return { result, stop: () => scope.stop() };
}

function gmailEnabled(inner: MailClient): void {
  const withAccount = inner as unknown as {
    controls: { setAccount(status: Record<string, unknown>): void };
  };
  withAccount.controls.setAccount({
    mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'enabled',
  });
}

describe('useMailbox group recovery fences', () => {
  it('keeps unresolved intent and the mutation fence against dismissal', async () => {
    const inner = createBrowserFakeMailClient();
    let rejectOnce = true;
    let sentRequestId: string | null = null;
    const client: MailClient = {
      ...inner,
      setArchivedGroup: (command) => {
        if (rejectOnce) {
          rejectOnce = false;
          sentRequestId = command.requestId;
          return Promise.reject({ kind: 'network_unavailable' });
        }
        return inner.setArchivedGroup(command);
      },
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    const dispatched = await result.setArchivedGroup([fixtureRef('conv-01')], true);
    expect(dispatched).toBe(false);
    expect(result.lastGroup.value?.state).toBe('acceptance-unknown');
    expect(result.bulkUnresolved.value).toBe(true);

    // Dismissal does not release the unresolved acceptance: the original
    // request id/command and the mutation fence are kept (§3.3/§4.3).
    result.dismissGroupNotice();
    expect(result.lastGroup.value?.requestId).toBe(sentRequestId);
    expect(result.bulkUnresolved.value).toBe(true);
    // Further mutation dispatch stays fenced while unresolved.
    const refused = await result.setArchivedGroup([fixtureRef('conv-02')], true);
    expect(refused).toBe(false);
    expect(result.lastCommandError.value?.kind).toBe('busy');
    stop();
  });

  it('releases the fence immediately on a typed definitive admission rejection', async () => {
    const inner = createBrowserFakeMailClient();
    const client: MailClient = {
      ...inner,
      setArchivedGroup: () => Promise.reject({ kind: 'read_only' }),
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    const dispatched = await result.setArchivedGroup([fixtureRef('conv-01')], true);
    expect(dispatched).toBe(false);
    // Nothing committed and the rejection is definitive: no permanent
    // "Acceptance not yet known" lock — the slot is gone and mutations work.
    expect(result.lastGroup.value).toBeNull();
    expect(result.bulkUnresolved.value).toBe(false);
    expect(result.lastCommandError.value?.kind).toBe('read_only');
    stop();
  });

  it('fences group dispatch while a single mutation is awaiting acceptance', async () => {
    const inner = createBrowserFakeMailClient();
    const client: MailClient = {
      ...inner,
      // The single's receipt round trip never settles: the in-flight ref
      // stays set, which must fence group dispatch (P1).
      setArchived: () => new Promise<OperationReceipt>(() => {}),
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    void result.setArchived({ accountId: 'gmail-account', conversationId: 'conv-01' }, true);
    await vi.waitFor(() => {
      if (result.inFlightCommandRef.value === null) throw new Error('single not in flight yet');
    });
    const dispatched = await result.setArchivedGroup([fixtureRef('conv-02')], true);
    expect(dispatched).toBe(false);
    expect(result.lastCommandError.value?.kind).toBe('busy');
    expect(result.lastGroup.value).toBeNull();
    stop();
  });

  it('clears group surfaces on disconnect and rejects late old-session responses', async () => {
    const inner = createBrowserFakeMailClient();
    gmailEnabled(inner);
    let holdLists = false;
    let disconnected = false;
    const groupsGate = deferred<OperationGroupPage>();
    const detailGate = deferred<OperationGroupStatus | null>();
    const client: MailClient = {
      ...inner,
      disconnectAccount: async () => {
        await inner.disconnectAccount();
        disconnected = true;
      },
      // Only reads captured BEFORE the disconnect are held; the
      // post-disconnect refresh reads the real (cleared) client.
      listOperationGroups: (request) => (holdLists && !disconnected ? groupsGate.promise : inner.listOperationGroups(request)),
      getOperationGroup: (request) => (request.requestId === 'late-detail' ? detailGate.promise : inner.getOperationGroup(request)),
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    await flushMacrotasks(2);
    // Prime the surfaces with a committed group so they are nonempty.
    const gmailRef = { accountId: 'gmail-account', conversationId: 'conv-01' };
    await result.setArchivedGroup([gmailRef], true);
    await flushMacrotasks(3);
    expect(result.recentGroups.value.length).toBeGreaterThan(0);

    // Start late reads, then disconnect: their responses must not repopulate.
    holdLists = true;
    const lateList = result.refreshGroups();
    const lateDetail = result.openGroupDetail('late-detail');
    await result.disconnectAccount();
    groupsGate.resolve({
      groups: [{
        groupId: 'group-old', requestId: 'old-req', kind: 'archive', requestedArchived: true,
        acceptedAt: '2026-01-01T00:00:00Z', members: [gmailRef], undone: false,
      }],
      nextCursor: null,
    });
    detailGate.resolve({
      group: {
        groupId: 'group-old', requestId: 'old-req', accountId: 'fixture-account', kind: 'archive',
        requestedArchived: true, acceptedAt: '2026-01-01T00:00:00Z',
        members: [{ ordinal: 0, conversation: gmailRef, operationId: 'op-1', rejection: null }],
      },
      members: [],
      undo: { available: false, reason: 'expired', undoableUntil: null },
    });
    await lateList;
    await lateDetail;
    expect(result.recentGroups.value).toEqual([]);
    expect(result.groupDetail.value).toBeNull();
    stop();
  });

  it('keeps older group pages through refresh and appends pages via the retained cursor', async () => {
    const inner = createBrowserFakeMailClient();
    for (let i = 0; i < 12; i += 1) {
      await inner.setArchivedGroup(
        { accountId: 'fixture-account', members: [fixtureRef(`conv-${(i % 18) + 1}`)], archived: true, requestId: `page-req-${i}` },
      );
    }
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    await flushMacrotasks(3);
    expect(result.recentGroups.value).toHaveLength(10);
    expect(result.groupsHasMore.value).toBe(true);
    // A refresh retains the loaded page range (no collapse to one page).
    await result.refresh();
    await flushMacrotasks(3);
    expect(result.recentGroups.value.length).toBeGreaterThanOrEqual(10);
    await result.loadMoreGroups();
    expect(result.recentGroups.value.length).toBeGreaterThanOrEqual(11);
    expect(result.groupsHasMore.value).toBe(false);
    stop();
  });

  it('surfaces a failed group-history read as an error, not an empty list', async () => {
    const inner = createBrowserFakeMailClient();
    let failList = true;
    const client: MailClient = {
      ...inner,
      listOperationGroups: (request) => (failList ? Promise.reject({ kind: 'storage_unavailable' }) : inner.listOperationGroups(request)),
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    await flushMacrotasks(3);
    expect(result.groupsError.value?.kind).toBe('storage_unavailable');
    // Recovery: a successful retry clears the error and loads the list.
    failList = false;
    await result.refreshGroups();
    expect(result.groupsError.value).toBeNull();
    stop();
  });

  it('surfaces a failed group-detail read with a retry path instead of silent absence', async () => {
    const inner = createBrowserFakeMailClient();
    await inner.setArchivedGroup(
      { accountId: 'fixture-account', members: [fixtureRef('conv-01')], archived: true, requestId: 'detail-req-1' },
    );
    let failDetail = true;
    const client: MailClient = {
      ...inner,
      getOperationGroup: (request) => (failDetail ? Promise.reject({ kind: 'storage_unavailable' }) : inner.getOperationGroup(request)),
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    await result.openGroupDetail('detail-req-1');
    expect(result.groupDetailError.value?.kind).toBe('storage_unavailable');
    failDetail = false;
    await result.openGroupDetail('detail-req-1');
    expect(result.groupDetailError.value).toBeNull();
    expect(result.groupDetail.value?.group.requestId).toBe('detail-req-1');
    stop();
  });

  it('a stale pre-undo status response never overwrites the accepted undo receipt', async () => {
    const inner = createBrowserFakeMailClient();
    gmailEnabled(inner);
    // Hold every group-status response in a gate so response ORDER can be
    // controlled: a pre-undo capture must resolve after the undo landed.
    const gates: Array<{ gate: ReturnType<typeof deferred<OperationGroupStatus | null>>; base: Promise<OperationGroupStatus | null> }> = [];
    const client: MailClient = {
      ...inner,
      getOperationGroup: (request) => {
        const base = inner.getOperationGroup(request);
        const gate = deferred<OperationGroupStatus | null>();
        gates.push({ gate, base });
        return gate.promise;
      },
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    await result.setReadGroup([{ accountId: 'gmail-account', conversationId: 'conv-01' }], true);
    await flushMacrotasks(3);
    expect(result.lastGroup.value?.state).toBe('accepted');

    // Accept the group undo while the pre-undo status read is still held.
    const releaseAll = (): void => {
      for (const entry of gates) entry.base.then((status) => entry.gate.resolve(status));
    };
    const undoPromise = result.undoGroupAction();
    // The undo's own trailing status read enqueues a second gate.
    await vi.waitFor(() => {
      if (gates.length < 2) throw new Error('post-undo status read not started yet');
    });
    releaseAll();
    // The undo's trailing detail refetch enqueues a third gate mid-flight.
    await vi.waitFor(() => {
      if (gates.length < 3) throw new Error('detail refetch not started yet');
    });
    releaseAll();
    const receipt = await undoPromise;
    expect(receipt).not.toBeNull();
    // The stale pre-undo response must not restore a pre-undo slot (undo
    // re-offered) nor drop the accepted undo receipt.
    expect(result.lastGroup.value?.undone).not.toBeNull();
    expect(result.lastGroup.value?.status?.undo.available).toBe(false);
    stop();
  });

  it('refreshes the expanded group detail when authoritative state changes (review U7)', async () => {
    const inner = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    // Children stay queued until released.
    inner.controls.behavior.holdQueued = true;
    await result.setArchivedGroup([fixtureRef('conv-01'), fixtureRef('conv-02')], true);
    await flushMacrotasks(3);
    await result.openGroupDetail(result.lastGroup.value!.requestId);
    expect(result.groupDetail.value?.members.every((m) => m.status === 'queued')).toBe(true);
    // Release the children; the next authoritative refresh updates the
    // expanded detail without a manual reopen.
    inner.controls.release();
    await flushMacrotasks(4);
    await result.refresh();
    await flushMacrotasks(4);
    expect(result.groupDetail.value?.members.every((m) => m.status === 'confirmed')).toBe(true);
    stop();
  });
});
