import { describe, expect, it } from 'vitest';
import newsletterHtml from '../../crates/mail-core/src/synthetic/html/newsletter.html?raw';
import { createBrowserFakeMailClient, createBrowserPreviewMailClient } from '../../src/lib/ipc/browser-fake';

const ref = (id: number) => ({ accountId: 'fixture-account', conversationId: `conv-${String(id).padStart(2, '0')}` });

describe('HTML sample conversations', () => {
  it('exposes the six samples and their HTML states', async () => {
    const client = createBrowserFakeMailClient(undefined, undefined, undefined, { htmlSamples: true });
    const subjects = ['Fixture Weekly: issue 12', 'Plan for next week', 'Logo proof', 'Re: Venue options', 'Hostile HTML sample', 'Oversized HTML sample'];
    for (let id = 19; id <= 24; id += 1) {
      const conversation = await client.getConversation(ref(id));
      expect(conversation.subject).toBe(subjects[id - 19]);
      expect(conversation.messages.at(-1)?.htmlBody).toBe(id === 24 ? 'too_large' : 'available');
    }
    expect((await client.getConversation(ref(22))).messages[0]?.htmlBody).toBeUndefined();
    expect((await client.getConversation(ref(1))).messages[0]?.htmlBody).toBeUndefined();
  });

  it('serves HTML and inline images only for matching messages and accounts', async () => {
    const client = createBrowserFakeMailClient(undefined, undefined, undefined, { htmlSamples: true });
    expect(await client.getMessageHtml(ref(19), 'm-19-1')).toEqual({ html: newsletterHtml, inlineImages: [] });
    await expect(client.getMessageHtml(ref(22), 'm-22-1')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(client.getMessageHtml(ref(24), 'm-24-1')).rejects.toMatchObject({ kind: 'not_found' });
    const html = await client.getMessageHtml(ref(21), 'm-21-1');
    const image = await client.getInlineImage(ref(21), 'm-21-1', 'fixture-logo');
    expect(Array.from(atob(image.base64).slice(0, 8), (c) => c.charCodeAt(0))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(html.inlineImages).toEqual([{ contentId: 'logo@fixture.example', attachmentId: 'fixture-logo', mimeType: 'image/png', size: atob(image.base64).length }]);
    expect(await client.listAttachments(ref(21))).toContainEqual(expect.objectContaining({ filename: 'logo.png', mimeType: 'image/png' }));
    await expect(client.getMessageHtml({ ...ref(19), accountId: 'wrong' }, 'm-19-1')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(client.getInlineImage({ ...ref(21), accountId: 'wrong' }, 'm-21-1', 'fixture-logo')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(client.getInlineImage(ref(21), 'm-21-1', 'wrong')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('are on in the browser preview and off in the default test seed', async () => {
    const preview = await createBrowserPreviewMailClient().listConversations();
    const plain = await createBrowserFakeMailClient().listConversations();
    expect(preview.conversations.map((c) => c.ref.conversationId)).toContain('conv-19');
    expect(preview.conversations[0]?.ref.conversationId).toBe('conv-24');
    expect(plain.conversations.map((c) => c.ref.conversationId)).not.toContain('conv-19');
  });
});
