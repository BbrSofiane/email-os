import { describe, expect, it } from 'vitest';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';

const aIdentity = { accountId: 'fixture-a', emailAddress: 'a@example.test' };
const bIdentity = { accountId: 'fixture-b', emailAddress: 'b@example.test' };
const refA = { accountId: aIdentity.accountId, conversationId: 'conv-01' };
const refB = { accountId: bIdentity.accountId, conversationId: 'conv-01' };

describe('UX-13 synthetic immutable account owners (not native credentials)', () => {
  it('rejects cross-account conversation/action/group/draft references, not just different IDs', async () => {
    const a = createBrowserFakeMailClient(undefined, aIdentity);
    const b = createBrowserFakeMailClient(undefined, bIdentity);
    expect((await a.getConversation(refA)).messages.map((m) => m.id)).toEqual((await b.getConversation(refB)).messages.map((m) => m.id));
    await expect(a.getConversation(refB)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(a.setArchived({ conversation: refB, archived: true, requestId: 'same-key' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(a.setArchivedGroup({ accountId: bIdentity.accountId, members: [refB], archived: true, requestId: 'same-key' })).rejects.toMatchObject({ kind: 'invalid_request', field: 'accountId' });
    const command = { source: { kind: 'new_message' as const }, initialContent: null, requestId: 'same-key' };
    const draftA = await a.createDraft(command);
    const draftB = await b.createDraft(command);
    expect(draftA.ref.draftId).toBe(draftB.ref.draftId);
    await expect(a.getDraft(draftB.ref)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(a.saveDraft({ ref: draftB.ref, expectedRevision: 1, requestId: 'save', content: { to: '', cc: '', subject: '', bodyText: 'B only' } })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(a.deleteDraft({ ref: draftB.ref, expectedRevision: 1, requestId: 'delete' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(await b.listDrafts()).toHaveLength(1);
  });

  it('keeps identical group/request IDs, immutable targets and one-level Undo scoped to each client', async () => {
    const a = createBrowserFakeMailClient(undefined, aIdentity);
    const b = createBrowserFakeMailClient(undefined, bIdentity);
    a.controls.behavior.holdQueued = true; b.controls.behavior.holdQueued = true;
    const groupA = await a.setArchivedGroup({ accountId: aIdentity.accountId, members: [refA], archived: true, requestId: 'same-key' });
    const groupB = await b.setArchivedGroup({ accountId: bIdentity.accountId, members: [refB], archived: true, requestId: 'same-key' });
    expect(groupA.groupId).toBe(groupB.groupId);
    expect((await a.listConversations()).conversations).toHaveLength(17);
    expect((await b.listConversations()).conversations).toHaveLength(17);
    a.controls.addMessage('conv-01');
    await a.undoOperationGroup({ groupId: groupA.groupId, requestId: 'undo' });
    expect((await a.listConversations()).conversations).toHaveLength(18);
    expect((await b.listConversations()).conversations).toHaveLength(17);
    await expect(b.getOperationGroup({ accountId: aIdentity.accountId, requestId: 'same-key' })).rejects.toMatchObject({ kind: 'invalid_request' });
    expect((await a.getConversation(refA)).messages).toHaveLength(4);
    expect((await b.getConversation(refB)).messages).toHaveLength(3);
  });
});
