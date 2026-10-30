// @vitest-environment node
/**
 * Focused unit regressions for the synthetic reader fixture's reply
 * derivation (UX-02 P2-09).
 *
 * The fixture's createDraft must derive To/subject/Cc/body defaults and the
 * immutable threading reply link from the REQUESTED source conversation's
 * stored metadata — never hardcoded to read-01 — and must reject
 * mismatched/unavailable sources instead of silently fabricating a reply.
 * The same module also backs the real-Chrome rendered suite and the App
 * component suite, so these cases pin the shared seam.
 */
import { describe, expect, it } from 'vitest';
import { createReaderFixtureClient, markRetained, readerRef, READER_ACCOUNT_ID, type ReaderFixture } from './reader.fixture';

/** Patches read-03's synthetic reply context with an alternate Reply-To/references. */
function patchReplyTo(controls: ReaderFixture['controls'], replyToMailboxes: string[] | null, references?: string[]): void {
  controls.replaceDetail('read-03', {
    replyContext: {
      sourceMessageId: 'read-03-m1',
      fromMailbox: 'ada@example.test',
      replyToMailboxes,
      messageId: '<read-03-m1@mail.test>',
      references: references ?? ['<read-03-m1@mail.test>'],
    },
  });
}

describe('reader fixture reply derivation (P2-09)', () => {
  it('derives To/one-Re:/blank Cc/body and the per-thread link for read-03-m1 and records the outbound command', async () => {
    const { client, controls } = createReaderFixtureClient();
    const receipt = await client.createDraft({
      requestId: 'req-read-03',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    });
    expect(receipt.ref.accountId).toBe(READER_ACCOUNT_ID);
    const draft = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    expect(draft.content).toEqual({
      to: 'ada@example.test',
      cc: '',
      subject: 'Re: Neighbor thread read-03',
      bodyText: '',
    });
    expect(draft.replyLink).toEqual({
      conversation: readerRef('read-03'),
      sourceMessageId: 'read-03-m1',
      messageId: '<read-03-m1@mail.test>',
      references: ['<read-03-m1@mail.test>'],
    });
    expect(controls.draftCreations).toHaveLength(1);
    expect(controls.draftCreations[0]!.source).toEqual({
      kind: 'reply',
      conversation: readerRef('read-03'),
      sourceMessageId: 'read-03-m1',
    });
    expect(controls.draftCreations[0]!.initialContent).toBeNull();
  });

  it('derives the read-01 link from read-01 metadata only (never the old cross-thread hardcode)', async () => {
    const { client } = createReaderFixtureClient();
    const receipt = await client.createDraft({
      requestId: 'req-read-01',
      source: { kind: 'reply', conversation: readerRef('read-01'), sourceMessageId: 'read-01-m3' },
      initialContent: null,
    });
    const draft = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    expect(draft.content.subject).toBe('Re: Reader journey thread');
    expect(draft.replyLink).toEqual({
      conversation: readerRef('read-01'),
      sourceMessageId: 'read-01-m3',
      messageId: '<read-01-m3@mail.test>',
      references: ['<read-01-m1@mail.test>', '<read-01-m2@mail.test>', '<read-01-m3@mail.test>'],
    });
  });

  it('adds exactly one Re: prefix to an already-Re: subject', async () => {
    const { client, controls } = createReaderFixtureClient();
    controls.replaceDetail('read-03', { subject: 'Re: Neighbor thread read-03' });
    const receipt = await client.createDraft({
      requestId: 'req-re-prefix',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    });
    const draft = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    expect(draft.content.subject).toBe('Re: Neighbor thread read-03');
  });

  it('rejects a reply source that is not the displayed latest message', async () => {
    const { client, controls } = createReaderFixtureClient();
    await expect(client.createDraft({
      requestId: 'req-stale-source',
      source: { kind: 'reply', conversation: readerRef('read-01'), sourceMessageId: 'read-01-m2' },
      initialContent: null,
    })).rejects.toEqual({ kind: 'reply_unavailable' });
    expect(controls.draftCreations).toHaveLength(1);
  });

  it('rejects a source conversation without threading metadata instead of fabricating a link', async () => {
    const { client, controls } = createReaderFixtureClient();
    controls.replaceDetail('read-03', { replyContext: undefined });
    await expect(client.createDraft({
      requestId: 'req-no-metadata',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    })).rejects.toEqual({ kind: 'reply_unavailable' });
    expect(controls.draftCreations).toHaveLength(1);
  });

  it('rejects a reply whose conversation reference does not match the requested account', async () => {
    const { client, controls } = createReaderFixtureClient();
    await expect(client.createDraft({
      requestId: 'req-wrong-account',
      source: { kind: 'reply', conversation: { accountId: 'other-account', conversationId: 'read-03' }, sourceMessageId: 'read-03-m1' },
      initialContent: null,
    })).rejects.toEqual({ kind: 'reply_unavailable' });
    expect(controls.draftCreations).toHaveLength(1);
  });

  it('rejects a reply against a retained snapshot or an unknown conversation', async () => {
    const { client, controls } = createReaderFixtureClient();
    controls.replaceDetail('read-03', markRetained('2026-02-02T11:30:00Z'));
    await expect(client.createDraft({
      requestId: 'req-retained',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    })).rejects.toEqual({ kind: 'reply_unavailable' });
    await expect(client.createDraft({
      requestId: 'req-missing',
      source: { kind: 'reply', conversation: readerRef('read-99'), sourceMessageId: 'read-99-m1' },
      initialContent: null,
    })).rejects.toEqual({ kind: 'reply_unavailable' });
    expect(controls.draftCreations).toHaveLength(2);
  });

  it('keeps the threading link immutable across later content saves and repeated reads', async () => {
    const { client } = createReaderFixtureClient();
    const receipt = await client.createDraft({
      requestId: 'req-immutable',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    });
    const before = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    await client.saveDraft({
      ref: receipt.ref,
      expectedRevision: receipt.revision,
      requestId: 'req-save',
      content: { to: 'ada@example.test', cc: '', subject: 'Re: Neighbor thread read-03', bodyText: 'Edited body.' },
    });
    const after = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    expect(after.replyLink).toEqual(before.replyLink);
    expect(after.source).toEqual(before.source);
    expect(after.content.bodyText).toBe('Edited body.');
    const reread = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    expect(reread.replyLink).toEqual(before.replyLink);
  });

  it('keeps new-message drafts blank with no reply link', async () => {
    const { client, controls } = createReaderFixtureClient();
    const receipt = await client.createDraft({
      requestId: 'req-new',
      source: { kind: 'new_message' },
      initialContent: { to: '', cc: '', subject: '', bodyText: '' },
    });
    const draft = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    expect(draft.content).toEqual({ to: '', cc: '', subject: '', bodyText: '' });
    expect(draft.replyLink).toBeNull();
    expect(controls.draftCreations[0]!.source).toEqual({ kind: 'new_message' });
  });

  it('prefers a valid alternate Reply-To over the context From mailbox', async () => {
    const { client, controls } = createReaderFixtureClient();
    patchReplyTo(controls, ['bela@example.test']);
    const receipt = await client.createDraft({
      requestId: 'req-reply-to',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    });
    const draft = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    expect(draft.content.to).toBe('bela@example.test');
    // Threading metadata is unchanged by the Reply-To choice.
    expect(draft.replyLink).toEqual({
      conversation: readerRef('read-03'),
      sourceMessageId: 'read-03-m1',
      messageId: '<read-03-m1@mail.test>',
      references: ['<read-03-m1@mail.test>'],
    });
  });

  it('fails closed on present-but-empty Reply-To even with a valid From', async () => {
    const { client, controls } = createReaderFixtureClient();
    patchReplyTo(controls, []);
    await expect(client.createDraft({
      requestId: 'req-empty-reply-to',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    })).rejects.toEqual({ kind: 'reply_unavailable' });
  });

  it('rejects when every Reply-To target is the account self and none remain', async () => {
    const { client, controls } = createReaderFixtureClient();
    patchReplyTo(controls, ['reader@example.test']);
    await expect(client.createDraft({
      requestId: 'req-self-only',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    })).rejects.toEqual({ kind: 'reply_unavailable' });
  });

  it('filters the account self, deduplicates case-insensitively keeping the first spelling, and joins targets', async () => {
    const { client, controls } = createReaderFixtureClient();
    patchReplyTo(controls, ['Reader@example.test', 'Bela@example.test', 'bela@example.test', 'cara@example.test']);
    const receipt = await client.createDraft({
      requestId: 'req-dedup',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    });
    const draft = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    expect(draft.content.to).toBe('Bela@example.test, cara@example.test');
  });

  it('drops duplicated source Message-ID occurrences from references and appends it exactly once at the end', async () => {
    const { client, controls } = createReaderFixtureClient();
    patchReplyTo(controls, null, [
      '<anc1@mail.test>',
      '<read-03-m1@mail.test>',
      '<anc2@mail.test>',
      '<read-03-m1@mail.test>',
    ]);
    const receipt = await client.createDraft({
      requestId: 'req-dup-ref',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    });
    const draft = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    expect(draft.replyLink?.references).toEqual(['<anc1@mail.test>', '<anc2@mail.test>', '<read-03-m1@mail.test>']);
  });

  it('appends the source Message-ID when the ancestor references lack it', async () => {
    const { client, controls } = createReaderFixtureClient();
    patchReplyTo(controls, null, ['<anc1@mail.test>', '<anc2@mail.test>']);
    const receipt = await client.createDraft({
      requestId: 'req-missing-ref',
      source: { kind: 'reply', conversation: readerRef('read-03'), sourceMessageId: 'read-03-m1' },
      initialContent: null,
    });
    const draft = await client.getDraft({ accountId: READER_ACCOUNT_ID, draftId: receipt.ref.draftId });
    expect(draft.replyLink?.references).toEqual(['<anc1@mail.test>', '<anc2@mail.test>', '<read-03-m1@mail.test>']);
  });
});
