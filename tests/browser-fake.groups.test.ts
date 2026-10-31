/**
 * UX-05 browser-fake group seam semantics (synthetic only).
 *
 * The fake models the frozen seam (commit 6ee1260): bounded idempotent group
 * acceptance with typed per-member rejections, request-id group lookup (null
 * while uncommitted), cursor-paged group summaries, and one partial group Undo
 * with cancelled/compensating/skipped decisions. The fake stays in-memory and
 * non-durable; it proves UI-facing shapes, not native/provider behavior.
 */
import { describe, expect, it } from 'vitest';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { OPERATION_GROUP_MAX_MEMBERS } from '../src/lib/ipc/client';
import { fixtureRef, useGmailMode, waitFor } from './helpers';
import type { ConversationRef } from '../src/lib/ipc/client';

function ref(index: number): ConversationRef {
  return fixtureRef(`conv-${String(index).padStart(2, '0')}`);
}

describe('browser fake: group acceptance', () => {
  it('accepts a bounded archive group and returns an immutable receipt with ordinals', async () => {
    const fake = createBrowserFakeMailClient();
    const receipt = await fake.setArchivedGroup({
      accountId: 'fixture-account',
      members: [ref(1), ref(3), ref(5)],
      archived: true,
      requestId: 'req-1',
    });
    expect(receipt.groupId).toMatch(/^grp-/);
    expect(receipt.requestId).toBe('req-1');
    expect(receipt.kind).toBe('archive');
    expect(receipt.requestedArchived).toBe(true);
    expect(receipt.acceptedAt).toBeTruthy();
    expect(receipt.members.map((m) => m.ordinal)).toEqual([0, 1, 2]);
    expect(receipt.members.every((m) => m.operationId !== null && m.rejection === null)).toBe(true);
  });

  it('is idempotent per request and conflicts on a changed payload', async () => {
    const fake = createBrowserFakeMailClient();
    const first = await fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(1)], archived: true, requestId: 'req-1' });
    const replay = await fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(1)], archived: true, requestId: 'req-1' });
    expect(replay).toEqual(first);
    await expect(fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(2)], archived: true, requestId: 'req-1' }))
      .rejects.toMatchObject({ kind: 'request_id_conflict' });
  });

  it('rejects malformed structure, duplicates, cross-account members and bound violations without partial state', async () => {
    const fake = createBrowserFakeMailClient();
    await expect(fake.setArchivedGroup({ accountId: 'fixture-account', members: [], archived: true, requestId: 'r' }))
      .rejects.toMatchObject({ kind: 'invalid_request', field: 'members' });
    await expect(fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(1), ref(1)], archived: true, requestId: 'r' }))
      .rejects.toMatchObject({ kind: 'invalid_request', field: 'members' });
    await expect(fake.setArchivedGroup({ accountId: 'fixture-account', members: [{ accountId: 'other', conversationId: 'conv-01' }], archived: true, requestId: 'r' }))
      .rejects.toMatchObject({ kind: 'invalid_request', field: 'members' });
    await expect(fake.setArchivedGroup({
      accountId: 'fixture-account',
      members: Array.from({ length: OPERATION_GROUP_MAX_MEMBERS + 1 }, (_, i) => ref(i + 1)),
      archived: true,
      requestId: 'r',
    })).rejects.toMatchObject({ kind: 'invalid_request', field: 'members' });
    // No child operations were enqueued by any rejected request.
    expect(fake.controls.activity()).toEqual([]);
  });

  it('persists typed member rejections and still returns an idempotent all-rejected receipt', async () => {
    const fake = createBrowserFakeMailClient();
    const receipt = await fake.setArchivedGroup({
      accountId: 'fixture-account',
      members: [ref(1), fixtureRef('conv-missing')],
      archived: true,
      requestId: 'req-1',
    });
    expect(receipt.members[0]).toMatchObject({ ordinal: 0, rejection: null });
    expect(receipt.members[1]).toMatchObject({ ordinal: 1, operationId: null, rejection: 'conversation_missing' });
    const replay = await fake.setArchivedGroup({
      accountId: 'fixture-account',
      members: [ref(1), fixtureRef('conv-missing')],
      archived: true,
      requestId: 'req-1',
    });
    expect(replay).toEqual(receipt);
  });

  it('rejects read groups in fixture mode and accepts them in synthetic Gmail mode', async () => {
    const fake = createBrowserFakeMailClient();
    await expect(fake.setReadGroup({ accountId: 'fixture-account', members: [ref(1)], read: true, requestId: 'r' }))
      .rejects.toMatchObject({ kind: 'read_only' });
    useGmailMode(fake, { mutationAccess: 'enabled' });
    const gmailRef = (index: number): ConversationRef => ({ accountId: 'gmail-account', conversationId: `conv-${String(index).padStart(2, '0')}` });
    const receipt = await fake.setReadGroup({ accountId: 'gmail-account', members: [gmailRef(1), gmailRef(2)], read: true, requestId: 'r' });
    expect(receipt.kind).toBe('read');
    expect(receipt.requestedRead).toBe(true);
    expect(receipt.requestedArchived).toBeUndefined();
  });
});

describe('browser fake: group lookup and listing', () => {
  it('resolves null while nothing has committed, then the committed group by request id', async () => {
    const fake = createBrowserFakeMailClient();
    await expect(fake.getOperationGroup({ accountId: 'fixture-account', requestId: 'req-lost' })).resolves.toBeNull();
    await fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(1)], archived: true, requestId: 'req-lost' });
    const status = await fake.getOperationGroup({ accountId: 'fixture-account', requestId: 'req-lost' });
    expect(status?.group.requestId).toBe('req-lost');
    expect(status?.members).toHaveLength(1);
    expect(status?.undo.available).toBe(true);
  });

  it('rejects cross-account and malformed lookups', async () => {
    const fake = createBrowserFakeMailClient();
    await expect(fake.getOperationGroup({ accountId: 'other-account', requestId: 'r' }))
      .rejects.toMatchObject({ kind: 'invalid_request', field: 'accountId' });
  });

  it('pages group summaries newest-first with a cursor and keeps addressability by request id', async () => {
    const fake = createBrowserFakeMailClient();
    for (let i = 1; i <= 3; i += 1) {
      await fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(i)], archived: true, requestId: `req-${i}` });
    }
    const page1 = await fake.listOperationGroups({ accountId: 'fixture-account', limit: 2, cursor: null });
    expect(page1.groups).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await fake.listOperationGroups({ accountId: 'fixture-account', limit: 2, cursor: page1.nextCursor });
    expect(page2.groups).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    // A group absent from a recent page stays addressable by request identity.
    const status = await fake.getOperationGroup({ accountId: 'fixture-account', requestId: 'req-1' });
    expect(status).not.toBeNull();
  });
});

describe('browser fake: group undo', () => {
  it('cancels queued members in place and reports the decision', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.behavior.holdQueued = true;
    await fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(1), ref(2)], archived: true, requestId: 'req-1' });
    const status = await fake.getOperationGroup({ accountId: 'fixture-account', requestId: 'req-1' });
    const groupId = status!.group.groupId;
    const receipt = await fake.undoOperationGroup({ groupId, requestId: 'undo-1' });
    expect(receipt.members).toHaveLength(2);
    expect(receipt.members.every((m) => m.decision.kind === 'cancelled')).toBe(true);
    // Queued intent cancelled: no provider application, statuses visible.
    const after = await fake.getOperationGroup({ accountId: 'fixture-account', requestId: 'req-1' });
    expect(after!.members.every((m) => m.status === 'cancelled')).toBe(true);
    expect(after!.undo).toMatchObject({ available: false, reason: 'already_undone' });
  });

  it('compensates confirmed members from original preimages and skips failed siblings', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.behavior.failNext = 1; // second child op fails definitively
    await fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(1), ref(2)], archived: true, requestId: 'req-1' });
    await waitFor(() => fake.controls.activity().every((op) => op.status !== 'queued' && op.status !== 'applying'));
    const status = await fake.getOperationGroup({ accountId: 'fixture-account', requestId: 'req-1' });
    const statuses = status!.members.map((m) => m.status).sort();
    expect(statuses).toEqual(['confirmed', 'failed']);
    const groupId = status!.group.groupId;
    const receipt = await fake.undoOperationGroup({ groupId, requestId: 'undo-1' });
    const kinds = receipt.members.map((m) => m.decision.kind).sort();
    expect(kinds).toEqual(['compensating', 'skipped']);
    const skipped = receipt.members.find((m) => m.decision.kind === 'skipped');
    expect(skipped && 'reason' in skipped.decision && skipped.decision.reason).toBe('failed');
    const compensated = receipt.members.find((m) => m.decision.kind === 'compensating');
    expect(compensated!.operationIds.length).toBeGreaterThan(0);
  });

  it('skips acceptance-rejected members and unknown-outcome members with typed reasons', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.behavior.failNext = 1;
    fake.controls.behavior.failureKind = 'outcome_unknown';
    await fake.setArchivedGroup({
      accountId: 'fixture-account',
      members: [ref(1), fixtureRef('conv-missing'), ref(2)],
      archived: true,
      requestId: 'req-1',
    });
    await waitFor(() => fake.controls.activity().some((op) => op.status === 'outcome_unknown'));
    const status = await fake.getOperationGroup({ accountId: 'fixture-account', requestId: 'req-1' });
    const receipt = await fake.undoOperationGroup({ groupId: status!.group.groupId, requestId: 'undo-1' });
    const reasons = receipt.members
      .filter((m) => m.decision.kind === 'skipped')
      .map((m) => (m.decision.kind === 'skipped' ? m.decision.reason : null));
    expect(reasons.sort()).toEqual(['acceptance_rejected', 'outcome_unknown']);
  });

  it('rejects a second undo attempt (any request id) with already_undone and replays the same request idempotently', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.behavior.holdQueued = true;
    await fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(1)], archived: true, requestId: 'req-1' });
    const status = await fake.getOperationGroup({ accountId: 'fixture-account', requestId: 'req-1' });
    const groupId = status!.group.groupId;
    const first = await fake.undoOperationGroup({ groupId, requestId: 'undo-1' });
    await expect(fake.undoOperationGroup({ groupId, requestId: 'undo-2' }))
      .rejects.toMatchObject({ kind: 'undo_unavailable', reason: 'already_undone' });
    // The same undo request replays the same decisions, not a new pass.
    await expect(fake.undoOperationGroup({ groupId, requestId: 'undo-1' })).resolves.toEqual(first);
  });

  it('supersession: a newer single action makes the older group undo unavailable', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.behavior.holdQueued = true;
    await fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(1)], archived: true, requestId: 'req-group' });
    await fake.setArchived({ conversation: ref(5), archived: true, requestId: 'req-single' });
    const status = await fake.getOperationGroup({ accountId: 'fixture-account', requestId: 'req-group' });
    expect(status!.undo).toMatchObject({ available: false, reason: 'superseded' });
  });

  it('group children never advertise individual undo and a newer group supersedes an older single', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.behavior.holdQueued = true;
    await fake.setArchived({ conversation: ref(5), archived: true, requestId: 'req-single' });
    await fake.setArchivedGroup({ accountId: 'fixture-account', members: [ref(1)], archived: true, requestId: 'req-group' });
    const single = fake.controls.activity().find((op) => op.conversation.conversationId === 'conv-05');
    expect(single?.undoableUntil).toBeUndefined(); // superseded by the group
    const status = await fake.getOperationGroup({ accountId: 'fixture-account', requestId: 'req-group' });
    expect(status!.undo.available).toBe(true);
    // Attempting to undo a group child as a single action fails closed.
    const childId = status!.group.members[0]!.operationId!;
    await expect(fake.undoOperation({ operationId: childId, requestId: 'undo-child' }))
      .rejects.toMatchObject({ kind: 'undo_unavailable' });
  });
});
