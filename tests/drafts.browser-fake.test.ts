import { describe, expect, it } from 'vitest';
import type { CreateDraft, DraftContent, SaveDraft } from '../src/lib/ipc/client';
import { createBrowserFakeMailClient, fixtureRef } from './helpers';

const blank: DraftContent = { to: '', cc: '', subject: '', bodyText: '' };

describe('browser preview local-draft fake (memory-only contract)', () => {
  it('scopes draft listing by account and works while Gmail mutation access is read-only', async () => {
    const fake = createBrowserFakeMailClient();
    const create: CreateDraft = { requestId: 'create-a', source: { kind: 'new_message' }, initialContent: blank };
    const fixtureReceipt = await fake.createDraft(create);
    expect(fixtureReceipt.ref.accountId).toBe('fixture-account');
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'read_only' });
    expect(await fake.listDrafts()).toEqual([]);
    const gmailReceipt = await fake.createDraft({ ...create, requestId: 'create-b' });
    expect(gmailReceipt.ref.accountId).toBe('gmail-account');
    expect((await fake.listDrafts()).map((draft) => draft.ref.accountId)).toEqual(['gmail-account']);
    fake.controls.setAccount({ mode: 'fixture', connection: 'connected', emailAddress: 'you@fixture.emailos' });
    expect((await fake.listDrafts()).map((draft) => draft.ref.accountId)).toEqual(['fixture-account']);
  });

  it('uses CAS revisions and returns original request receipts after later saves and deletion', async () => {
    const fake = createBrowserFakeMailClient(() => '2025-02-03T04:05:06.000Z');
    const created = await fake.createDraft({ requestId: 'create-cas', source: { kind: 'new_message' }, initialContent: blank });
    const firstSave: SaveDraft = { ref: created.ref, expectedRevision: 1, requestId: 'save-first', content: { ...blank, bodyText: 'exact ✓' } };
    const firstReceipt = await fake.saveDraft(firstSave);
    expect(firstReceipt.revision).toBe(2);
    expect(await fake.saveDraft(firstSave)).toEqual(firstReceipt);
    expect(await fake.getDraft(created.ref)).toMatchObject({ revision: 2, content: firstSave.content });
    await expect(fake.saveDraft({ ...firstSave, requestId: 'stale-save', content: { ...blank, bodyText: 'must not win' } }))
      .rejects.toEqual({ kind: 'draft_conflict', currentRevision: 2 });

    const next = await fake.saveDraft({ ref: created.ref, expectedRevision: 2, requestId: 'save-next', content: { ...blank, bodyText: 'newest' } });
    expect(next.revision).toBe(3);
    expect(await fake.saveDraft(firstSave)).toEqual(firstReceipt);
    const deletion = { ref: created.ref, expectedRevision: 3, requestId: 'delete-cas' };
    const deleted = await fake.deleteDraft(deletion);
    expect(await fake.deleteDraft(deletion)).toEqual(deleted);
    expect(await fake.saveDraft(firstSave)).toEqual(firstReceipt);
    await expect(fake.getDraft(created.ref)).rejects.toEqual({ kind: 'not_found' });
  });

  it('captures immutable synthetic reply threading to the exact latest source', async () => {
    const fake = createBrowserFakeMailClient();
    const conversation = await fake.getConversation(fixtureRef('conv-03'));
    const latest = conversation.messages.at(-1)!;
    const source = { kind: 'reply' as const, conversation: conversation.ref, sourceMessageId: latest.id };
    const reply = await fake.createDraft({ requestId: 'reply-captured', source, initialContent: null });
    const before = await fake.getDraft(reply.ref);
    expect(before.content).toMatchObject({ to: 'ada@example.test', cc: '', subject: `Re: ${conversation.subject}`, bodyText: '' });
    expect(before.replyLink).toMatchObject({ conversation: conversation.ref, sourceMessageId: latest.id, messageId: `<${latest.id}@fixture.emailos>` });
    fake.controls.addMessage('conv-03');
    const after = await fake.getDraft(reply.ref);
    expect(after.replyLink).toEqual(before.replyLink);
    await expect(fake.createDraft({ requestId: 'stale-reply', source, initialContent: null })).rejects.toEqual({ kind: 'reply_unavailable' });
    await expect(fake.createDraft({
      requestId: 'missing-reply-source',
      source: { kind: 'reply', conversation: fixtureRef('missing-conversation'), sourceMessageId: 'missing-message' },
      initialContent: null,
    })).rejects.toEqual({ kind: 'not_found' });
  });

  it('does not resurrect a deleted draft when a previously unacknowledged save arrives late', async () => {
    const fake = createBrowserFakeMailClient();
    const created = await fake.createDraft({ requestId: 'create-late', source: { kind: 'new_message' }, initialContent: blank });
    const lateSave: SaveDraft = { ref: created.ref, expectedRevision: 1, requestId: 'late-save', content: { ...blank, bodyText: 'late' } };
    await fake.deleteDraft({ ref: created.ref, expectedRevision: 1, requestId: 'delete-before-late-save' });
    await expect(fake.saveDraft(lateSave)).rejects.toEqual({ kind: 'not_found' });
    expect(await fake.listDrafts()).toEqual([]);
  });

  it('rejects over-limit text and request IDs without truncating', async () => {
    const fake = createBrowserFakeMailClient();
    await expect(fake.createDraft({ requestId: 'create-too-long', source: { kind: 'new_message' }, initialContent: { ...blank, bodyText: 'x'.repeat(1024 * 1024 + 1) } }))
      .rejects.toEqual({ kind: 'invalid_request', field: 'bodyText' });
    await expect(fake.createDraft({ requestId: 'x'.repeat(129), source: { kind: 'new_message' }, initialContent: blank }))
      .rejects.toEqual({ kind: 'invalid_request', field: 'requestId' });
    expect(await fake.listDrafts()).toEqual([]);
  });

  it('deduplicates close request delivery and requires matching complete or cancel IDs', async () => {
    const fake = createBrowserFakeMailClient();
    const request = fake.controls.requestAppClose();
    const received: string[] = [];
    const unlisten = await fake.subscribeAppClose((item) => received.push(item.requestId));
    expect(received).toEqual([request.requestId]);
    await expect(fake.completeAppClose('stale')).rejects.toMatchObject({ kind: 'invalid_request' });
    await fake.cancelAppClose(request.requestId);
    const next = fake.controls.requestAppClose();
    expect(next.requestId).not.toBe(request.requestId);
    await fake.completeAppClose(next.requestId);
    expect(fake.controls.completedCloseCount()).toBe(1);
    unlisten();
    expect(fake.controls.closeListenerCount()).toBe(0);
  });
});
