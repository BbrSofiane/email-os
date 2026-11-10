/**
 * Reader design pass: one status line instead of standing paragraphs, trailing
 * quote and signature disclosure, and inline attachment rows. Message content
 * stays literal text throughout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ReaderView from '../src/components/ReaderView.vue';
import type { Conversation, ConversationRef, MailClient } from '../src/lib/ipc/client';
import type { AttachmentDescriptor } from '../src/lib/ipc/generated';
import { deferred } from './helpers';

const ACCOUNT = 'account-a';
const ref = (conversationId: string): ConversationRef => ({ accountId: ACCOUNT, conversationId });

function message(id: string, bodyText = `Body of ${id}.`, extra: Record<string, unknown> = {}) {
  return {
    id,
    from: { displayName: 'Ada Fixture', mailbox: 'ada@example.test' },
    to: [{ displayName: 'You', mailbox: 'you@example.test' }],
    sentAt: '2026-02-02T09:00:00Z',
    bodyText,
    ...extra,
  };
}

function conversationOf(conversationId: string, messages: ReturnType<typeof message>[], extra: Partial<Conversation> = {}): Conversation {
  return {
    ref: ref(conversationId),
    subject: `Subject ${conversationId}`,
    messages,
    isInInbox: true,
    pendingOperationId: null,
    ...extra,
  };
}

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

function mountReader(conversation: Conversation, props: Record<string, unknown> = {}): VueWrapper {
  wrapper = mount(ReaderView, {
    props: { conversation, state: 'ready', error: null, commandInFlight: false, openRef: conversation.ref, ...props },
    attachTo: document.body,
  });
  return wrapper;
}

async function settle(): Promise<void> {
  await flushPromises();
  await nextTick();
  await flushPromises();
}

async function show(w: VueWrapper, conversation: Conversation): Promise<void> {
  await w.setProps({ conversation, openRef: conversation.ref, state: 'ready' });
  await settle();
}

describe('reader status line and exceptions', () => {
  const ONE_LINE_AUTO = 'Opening this conversation does not change read state; use an explicit read control.';
  const ONE_LINE_RO = 'Read-only Gmail view: messages are never marked as read. Opening this conversation does not change read state.';

  it('replaces the explicit-read-control paragraph with one status line: title and hidden text, exact read-state word', async () => {
    const w = mountReader(conversationOf('c1', [message('m1')], { isRead: false }), { showReadControls: true });
    await settle();
    const line = w.get('[data-test="reader-no-auto-read"]');
    expect(line.element.closest('[data-test="reader-meta-row"]')).not.toBeNull();
    expect(line.element.tagName).toBe('SPAN');
    expect(line.attributes('title')).toBe(ONE_LINE_AUTO);
    expect(w.get('[data-test="reader-status-detail"]').text()).toBe(ONE_LINE_AUTO);
    expect(w.get('[data-test="reader-status-detail"]').classes()).toContain('visually-hidden');
    expect(w.get('[data-test="reader-read-state"]').text()).toBe('Unread');
    // The sentence is no longer a visible paragraph.
    expect(w.find('p.reader-readonly').exists()).toBe(false);
    expect(w.findAll('p').some((p) => p.text().includes(ONE_LINE_AUTO))).toBe(false);
  });

  it('shows Read-only and the read state in the same line for a read-only view', async () => {
    const w = mountReader(conversationOf('c1', [message('m1')], { isRead: true }), { readOnly: true });
    await settle();
    const line = w.get('[data-test="reader-readonly"]');
    expect(line.element.tagName).toBe('SPAN');
    expect(line.get('[data-test="reader-status-word"]').text()).toBe('Read-only');
    expect(line.get('[data-test="reader-read-state"]').text()).toBe('Read');
    expect(line.attributes('title')).toBe(ONE_LINE_RO);
    expect(line.get('[data-test="reader-status-detail"]').text()).toBe(ONE_LINE_RO);
    expect(w.find('p.reader-readonly').exists()).toBe(false);
    expect(w.find('[data-test="reader-no-auto-read"]').exists()).toBe(false);
  });

  it('keeps one Cached Trash line without the read-state sentence', async () => {
    const w = mountReader(conversationOf('c1', [message('m1')], { isRead: true }), { readOnly: true, browsingOnly: true });
    await settle();
    const notes = w.findAll('p.reader-readonly');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text()).toBe('Cached Trash — read only. Recovery is not available here; use your provider client.');
    expect(w.find('[data-test="reader-readonly"]').exists()).toBe(false);
    // The read-state span names the mode too, so "Read" is never shown bare in a read-only view.
    expect(w.get('[data-test="reader-status-word"]').text()).toBe('Read-only');
    expect(w.get('[data-test="reader-read-state"]').text()).toBe('Read');
    expect(w.find('[data-test="reader-status-detail"]').exists()).toBe(false);
  });

  it('adds nothing under the subject for a plain conversation without exceptions', async () => {
    const w = mountReader(conversationOf('c1', [message('m1')], { isRead: true }));
    await settle();
    expect(w.find('[data-test="reader-meta-row"]').exists()).toBe(false);
    expect(w.findAll('.reader-scroll p')).toHaveLength(0);
  });

  it('shows every exception once, inline, with unchanged wording', async () => {
    const w = mountReader(
      conversationOf('c1', [message('m1')], {
        isRead: false,
        stars: { starredMessages: 1, knownMessages: 1, totalMessages: 2 },
        retainedSnapshotAt: '2025-02-03T04:05:06Z',
        unsupportedReason: 'attachments omitted',
        contextComplete: false,
        pendingOperationId: 'op-1',
      }),
      { showReadControls: true },
    );
    await settle();
    for (const hook of ['reader-stars', 'reply-blocked', 'retained-snapshot-notice', 'unsupported-notice', 'reader-pending', 'reader-no-auto-read']) {
      expect(w.findAll(`[data-test="${hook}"]`), hook).toHaveLength(1);
    }
    // The incomplete-context notice is the else-branch of the unsupported notice.
    expect(w.find('[data-test="context-incomplete"]').exists()).toBe(false);
    expect(w.get('[data-test="unsupported-notice"]').text()).toBe('Some content is not shown: attachments omitted');
    expect(w.get('[data-test="reader-pending"]').text()).toBe('A mailbox action is pending for this conversation.');
    // Exactly the four exception paragraphs plus the star line: no standing sentences.
    expect(w.findAll('.reader-scroll > p')).toHaveLength(5);
  });

  it('exposes the pending line as the reader\'s one status; the other exceptions stay notes, not live regions', async () => {
    const w = mountReader(
      conversationOf('c1', [message('m1')], {
        isRead: false,
        retainedSnapshotAt: '2025-02-03T04:05:06Z',
        unsupportedReason: 'attachments omitted',
        pendingOperationId: 'op-1',
      }),
      { showReadControls: true },
    );
    await settle();
    expect(w.get('[data-test="reader-pending"]').attributes('role')).toBe('status');
    expect(w.get('[data-test="retained-snapshot-notice"]').attributes('role')).toBe('note');
    expect(w.get('[data-test="unsupported-notice"]').attributes('role')).toBe('note');
    // Quiet: exactly one live region in the reader body.
    expect(w.findAll('.reader-scroll [role="status"], .reader-scroll [role="alert"], .reader-scroll [aria-live]')).toHaveLength(1);
  });

  it('marks the bare loading line as a status without changing its text', async () => {
    wrapper = mount(ReaderView, {
      props: { conversation: null, state: 'loading', error: null, commandInFlight: false, openRef: ref('c1') },
      attachTo: document.body,
    });
    const line = wrapper.get('[data-test="reader-loading"]');
    expect(line.text()).toBe('Loading conversation…');
    expect(line.attributes('role')).toBe('status');
  });
});

describe('trailing quote and signature', () => {
  const QUOTED = 'On Thu, Ada wrote:\n> can we ship?\n> <img src=x onerror="alert(1)">';
  const BODY = `Shipping Friday.\n\n${QUOTED}`;

  it('hides a trailing quote behind a real toggle and shows it as literal text', async () => {
    const w = mountReader(conversationOf('c1', [message('m1', BODY)]));
    await settle();
    expect(w.get('[data-test="message-body"]').text()).toBe('Shipping Friday.');
    expect(w.get('[data-test="message-body"]').classes()).not.toContain('message-body-mono');
    expect(w.find('[data-test="message-quoted"]').exists()).toBe(false);
    const toggle = w.get('[data-test="message-quote-toggle-m1"]');
    expect(toggle.element.tagName).toBe('BUTTON');
    expect(toggle.attributes('type')).toBe('button');
    expect(toggle.text()).toBe('Show quoted text');
    expect(toggle.attributes('aria-expanded')).toBe('false');

    await toggle.trigger('click');
    expect(toggle.text()).toBe('Hide quoted text');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    const quoted = w.get('[data-test="message-quoted"]');
    expect(toggle.attributes('aria-controls')).toBe(quoted.attributes('id'));
    expect(quoted.text()).toBe(QUOTED);
    expect(quoted.find('img').exists()).toBe(false);
    expect(w.get('.reader-scroll').find('img').exists()).toBe(false);

    await toggle.trigger('click');
    expect(w.find('[data-test="message-quoted"]').exists()).toBe(false);
    expect(toggle.attributes('aria-controls')).toBeUndefined();
  });

  it('renders the signature below the prose without a toggle, in its own block', async () => {
    const w = mountReader(conversationOf('c1', [message('m1', 'Thanks.\n-- \nAda\nExample Co')]));
    await settle();
    expect(w.get('[data-test="message-body"]').text()).toBe('Thanks.');
    expect(w.get('[data-test="message-signature"]').text()).toBe('-- \nAda\nExample Co');
    expect(w.find('[data-test="message-quote-toggle-m1"]').exists()).toBe(false);
  });

  it('leaves a body without a trailing quote or signature exactly as before (an interleaved quote no longer forces mono)', async () => {
    const plain = 'Hi,\n\nThanks > nothing.\n\nAda';
    const inline = '> Are we on?\nYes.\n> And Friday?\nAlso yes.';
    const w = mountReader(conversationOf('c1', [message('m1', plain), message('m2', inline)]));
    await settle();
    const bodies = w.findAll('[data-test="message-body"]');
    expect(bodies[0]!.text()).toBe(plain);
    expect(bodies[1]!.text()).toBe(inline);
    expect(bodies[0]!.classes()).not.toContain('message-body-mono');
    expect(bodies[1]!.classes()).not.toContain('message-body-mono');
    expect(w.find('.message-quote-toggle').exists()).toBe(false);
    expect(w.find('[data-test="message-signature"]').exists()).toBe(false);
  });

  it('previews the prose, not the quote, in a collapsed row', async () => {
    const w = mountReader(conversationOf('c1', [message('m1', BODY), message('m2')]));
    await settle();
    expect(w.get('[data-test="message-toggle-m1"]').get('.message-snippet').text()).toBe('Shipping Friday.');
    expect(w.get('[data-test="message-quote-toggle-m1"]').attributes('hidden')).toBeDefined();
  });

  it('collapses a localized quote, previews only the prose, and keeps an aligned prose block mono', async () => {
    const french = 'Merci, c’est bon.\n\nLe jeudi 6 nov. 2026, Ada a écrit\u00a0:\n> Peut-on livrer ?\n> Vendredi.';
    const aligned = 'Lancer :\n    $ pnpm test\n    ok\n\nAm Montag schrieb Ada:\n> Passt?\n> Ja.';
    const w = mountReader(conversationOf('c1', [message('m1', french), message('m2', aligned)]));
    await settle();
    expect(w.get('[data-test="message-toggle-m1"]').get('.message-snippet').text()).toBe('Merci, c’est bon.');
    expect(w.get('[data-test="message-quote-toggle-m1"]').text()).toBe('Show quoted text');
    const bodies = w.findAll('[data-test="message-body"]');
    expect(bodies[0]!.text()).toBe('Merci, c’est bon.');
    expect(bodies[0]!.classes()).not.toContain('message-body-mono');
    expect(bodies[1]!.classes()).toContain('message-body-mono');
    expect(w.find('[data-test="message-quote-toggle-m2"]').exists()).toBe(true);
  });

  it('keeps the disclosure open across a J/K round trip', async () => {
    const first = conversationOf('c1', [message('m1', BODY)]);
    const neighbor = conversationOf('c2', [message('n1')]);
    const w = mountReader(first);
    await settle();
    await w.get('[data-test="message-quote-toggle-m1"]').trigger('click');
    expect(w.find('[data-test="message-quoted"]').exists()).toBe(true);
    await show(w, neighbor);
    await show(w, first);
    expect(w.get('[data-test="message-quote-toggle-m1"]').attributes('aria-expanded')).toBe('true');
    expect(w.get('[data-test="message-quoted"]').text()).toBe(QUOTED);
  });
});

describe('inline attachments', () => {
  const FILE: AttachmentDescriptor = { messageId: 'm1', attachmentId: 'a1', filename: 'example.txt', mimeType: 'text/plain', size: 27 };

  function stubClient(files: AttachmentDescriptor[] | Promise<AttachmentDescriptor[]> = [FILE]) {
    return {
      listAttachments: vi.fn(() => Promise.resolve(files)),
      saveAttachment: vi.fn(() => Promise.resolve({ filename: 'example.txt.download' })),
      cancelAttachment: vi.fn(() => Promise.resolve()),
    };
  }
  const asClient = (stub: ReturnType<typeof stubClient>) => stub as unknown as MailClient;
  const withFile = (id = 'c1') => conversationOf(id, [message('m1', 'Body', { hasAttachment: true })]);

  it('lists a known file with a human size, type and a Save button, loading once per conversation', async () => {
    const client = stubClient();
    const first = withFile();
    const neighbor = conversationOf('c2', [message('n1', 'Body', { hasAttachment: false })]);
    const w = mountReader(first, { client: asClient(client) });
    await settle();
    const row = w.get('[data-test="attachment-a1"]');
    expect(row.text()).toContain('example.txt');
    expect(row.text()).toContain('27 B · text/plain');
    const save = row.get('[data-test="attachment-save"]');
    expect(save.text()).toBe('Save');
    expect(save.attributes('aria-label')).toBe('Save example.txt');
    expect(client.listAttachments).toHaveBeenCalledExactlyOnceWith(first.ref);
    expect(client.saveAttachment).not.toHaveBeenCalled();
    // J/K to a conversation with no claim, and back: still one fetch, nothing refetched.
    await show(w, neighbor);
    expect(w.find('[data-test="message-attachments-n1"]').exists()).toBe(false);
    await show(w, first);
    expect(w.find('[data-test="attachment-a1"]').exists()).toBe(true);
    expect(client.listAttachments).toHaveBeenCalledTimes(1);
  });

  it('shows nothing and never fetches for hasAttachment false or unknown, and without a client', async () => {
    const client = stubClient();
    const none = conversationOf('c1', [message('m1', 'Body', { hasAttachment: false }), message('m2')]);
    const w = mountReader(none, { client: asClient(client) });
    await settle();
    expect(w.find('[data-test="message-attachments-m1"]').exists()).toBe(false);
    expect(w.find('[data-test="message-attachments-m2"]').exists()).toBe(false);
    expect(client.listAttachments).not.toHaveBeenCalled();
    w.unmount();
    const plain = mountReader(withFile());
    await settle();
    expect(plain.find('.message-attachments').exists()).toBe(false);
  });

  it('saves on request and reports exactly what happened, including the preview wording', async () => {
    const client = stubClient();
    const w = mountReader(withFile(), { client: asClient(client) });
    await settle();
    await w.get('[data-test="attachment-save"]').trigger('click');
    await settle();
    expect(client.saveAttachment).toHaveBeenCalledWith({ conversation: ref('c1'), messageId: 'm1', attachmentId: 'a1', requestId: expect.any(String) });
    const status = w.get('[data-test="attachment-status"]');
    expect(status.text()).toBe('Saved to Downloads as example.txt.download. No file was opened.');
    expect(status.attributes('role')).toBe('status');
    w.unmount();

    const previewClient = stubClient();
    const preview = mountReader(withFile(), { client: asClient(previewClient), preview: true });
    await settle();
    await preview.get('[data-test="attachment-save"]').trigger('click');
    await settle();
    expect(preview.get('[data-test="attachment-status"]').text()).toBe('Modelled save in preview memory only; no file was written.');
  });

  it('shows a failed save as an alert with the chooser wording and allows an explicit retry', async () => {
    const client = stubClient();
    client.saveAttachment.mockRejectedValueOnce({ kind: 'network_unavailable' });
    const w = mountReader(withFile(), { client: asClient(client) });
    await settle();
    await w.get('[data-test="attachment-save"]').trigger('click');
    await settle();
    const alert = w.get('[data-test="attachment-error"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toContain('File not saved: unavailable offline, missing, cancelled, too large, or invalid content.');
    expect(w.find('[data-test="attachment-status"]').exists()).toBe(false);
    await w.get('[data-test="attachment-save"]').trigger('click');
    await settle();
    expect(client.saveAttachment).toHaveBeenCalledTimes(2);
    expect(w.find('[data-test="attachment-error"]').exists()).toBe(false);
  });

  it('shows Saving… with Cancel while transferring, disables other saves, and requests cancellation', async () => {
    const second: AttachmentDescriptor = { ...FILE, attachmentId: 'a2', filename: 'b.txt' };
    const client = stubClient([FILE, second]);
    const transfer = deferred<{ filename: string }>();
    client.saveAttachment.mockReturnValueOnce(transfer.promise as never);
    const w = mountReader(withFile(), { client: asClient(client) });
    await settle();
    await w.get('[data-test="attachment-a1"] [data-test="attachment-save"]').trigger('click');
    await settle();
    const request = (client.saveAttachment.mock.calls[0] as unknown as [{ requestId: string }])[0];
    expect(w.get('[data-test="attachment-a1"]').text()).toContain('Saving…');
    expect(w.get('[data-test="attachment-a1"] [data-test="attachment-save"]').attributes('aria-disabled')).toBe('true');
    expect(w.get('[data-test="attachment-a2"] [data-test="attachment-save"]').attributes('disabled')).toBeDefined();
    await w.get('[data-test="attachment-cancel"]').trigger('click');
    await settle();
    expect(client.cancelAttachment).toHaveBeenCalledWith(request.requestId);
    expect(w.get('[data-test="attachment-status"]').text()).toBe('Cancellation requested; waiting for transfer to stop.');
    transfer.reject({ kind: 'cancelled' });
    await settle();
    expect(w.find('[data-test="attachment-cancel"]').exists()).toBe(false);
    expect(w.get('[data-test="attachment-a1"]').text()).not.toContain('Saving…');
    expect(w.get('[data-test="attachment-a1"] [data-test="attachment-save"]').attributes('disabled')).toBeUndefined();
  });

  it('cancels an in-flight transfer when the conversation changes or the reader closes', async () => {
    const client = stubClient();
    client.saveAttachment.mockReturnValue(new Promise(() => {}) as never);
    const first = withFile();
    const w = mountReader(first, { client: asClient(client) });
    await settle();
    await w.get('[data-test="attachment-save"]').trigger('click');
    await settle();
    await show(w, conversationOf('c2', [message('n1')]));
    expect(client.cancelAttachment).toHaveBeenCalledTimes(1);
    w.unmount();
    wrapper = null;
  });

  it('refuses files over 5 MB and disables saving for a retained snapshot', async () => {
    const big: AttachmentDescriptor = { ...FILE, attachmentId: 'big', filename: 'big.bin', mimeType: 'application/octet-stream', size: 6 * 1024 * 1024 };
    const client = stubClient([FILE, big]);
    const w = mountReader({ ...withFile(), retainedSnapshotAt: '2025-02-03T04:05:06Z' }, { client: asClient(client) });
    await settle();
    expect(w.get('[data-test="attachment-big"]').text()).toContain('6.0 MB · application/octet-stream');
    expect(w.get('[data-test="attachment-big"]').text()).toContain('Over the 5 MB limit; cannot download.');
    expect(w.find('[data-test="attachment-big"] [data-test="attachment-save"]').exists()).toBe(false);
    const save = w.get('[data-test="attachment-a1"] [data-test="attachment-save"]');
    expect(save.attributes('disabled')).toBeDefined();
    expect(save.attributes('title')).toContain('unavailable');
    await save.trigger('click');
    expect(client.saveAttachment).not.toHaveBeenCalled();
  });

  it('says so plainly when a message claims files but none are cached, and when the list cannot load', async () => {
    const client = stubClient([]);
    const w = mountReader(withFile(), { client: asClient(client) });
    await settle();
    expect(w.get('[data-test="attachments-not-cached"]').text()).toBe('Attachment details are not cached. Sync to fetch.');
    w.unmount();

    const failing = stubClient();
    failing.listAttachments.mockRejectedValue({ kind: 'storage_unavailable' });
    const failed = mountReader(withFile(), { client: asClient(failing) });
    await settle();
    expect(failed.get('[data-test="attachments-load-error"]').text()).toBe('Could not load file details.');
    expect(failed.get('.reader-scroll').text()).toContain('Body');
  });

  describe('saving keeps keyboard focus', () => {
    const saveButton = (w: VueWrapper) => w.get('[data-test="attachment-save"]');
    const cancelButton = (w: VueWrapper) => w.get('[data-test="attachment-cancel"]');

    it('keeps the same Save button mounted, focused and aria-disabled as Saving… while the transfer runs', async () => {
      const client = stubClient();
      const transfer = deferred<{ filename: string }>();
      client.saveAttachment.mockReturnValueOnce(transfer.promise as never);
      const w = mountReader(withFile(), { client: asClient(client) });
      await settle();
      const button = saveButton(w).element as HTMLButtonElement;
      button.focus();
      await saveButton(w).trigger('click');
      await settle();
      expect(client.saveAttachment).toHaveBeenCalledTimes(1);
      expect(saveButton(w).element).toBe(button);
      expect(document.activeElement).toBe(button);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.hasAttribute('disabled')).toBe(false);
      expect(button.textContent?.trim()).toBe('Saving…');
      expect(button.getAttribute('aria-label')).toBe('Saving example.txt');
      // A click or Enter while saving does not start a second transfer.
      await saveButton(w).trigger('click');
      expect(client.saveAttachment).toHaveBeenCalledTimes(1);
      // No new live region: only the existing saved/failed lines are status/alert.
      expect(w.get('[data-test="message-attachments-m1"]').findAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);

      transfer.resolve({ filename: 'example.txt.download' });
      await settle();
      expect(document.activeElement).toBe(saveButton(w).element);
      expect(document.activeElement).not.toBe(document.body);
      expect(saveButton(w).text()).toBe('Save');
      expect(saveButton(w).attributes('aria-disabled')).toBeUndefined();
      expect(saveButton(w).attributes('aria-label')).toBe('Save example.txt');
      expect(w.get('[data-test="attachment-status"]').attributes('role')).toBe('status');
    });

    it('keeps focus on Save when the transfer fails, and the alert still appears', async () => {
      const client = stubClient();
      const transfer = deferred<{ filename: string }>();
      client.saveAttachment.mockReturnValueOnce(transfer.promise as never);
      const w = mountReader(withFile(), { client: asClient(client) });
      await settle();
      (saveButton(w).element as HTMLButtonElement).focus();
      await saveButton(w).trigger('click');
      transfer.reject({ kind: 'network_unavailable' });
      await settle();
      expect(document.activeElement).toBe(saveButton(w).element);
      expect(w.get('[data-test="attachment-error"]').attributes('role')).toBe('alert');
    });

    it('hands focus back to Save when Cancel had it and the transfer stops', async () => {
      const client = stubClient();
      const transfer = deferred<{ filename: string }>();
      client.saveAttachment.mockReturnValueOnce(transfer.promise as never);
      const w = mountReader(withFile(), { client: asClient(client) });
      await settle();
      (saveButton(w).element as HTMLButtonElement).focus();
      await saveButton(w).trigger('click');
      await settle();
      (cancelButton(w).element as HTMLButtonElement).focus();
      await cancelButton(w).trigger('click');
      await settle();
      // Cancel is a request: it stays (and keeps focus) until the transfer stops.
      expect(document.activeElement).toBe(cancelButton(w).element);
      transfer.reject({ kind: 'cancelled' });
      await settle();
      expect(w.find('[data-test="attachment-cancel"]').exists()).toBe(false);
      expect(document.activeElement).toBe(saveButton(w).element);
    });

    it('does not take focus when the user moved elsewhere during the transfer', async () => {
      const client = stubClient();
      const transfer = deferred<{ filename: string }>();
      client.saveAttachment.mockReturnValueOnce(transfer.promise as never);
      const w = mountReader(withFile(), { client: asClient(client) });
      await settle();
      (saveButton(w).element as HTMLButtonElement).focus();
      await saveButton(w).trigger('click');
      await settle();
      (w.get('[data-test="message-toggle-m1"]').element as HTMLElement).focus();
      transfer.resolve({ filename: 'example.txt.download' });
      await settle();
      expect(document.activeElement).toBe(w.get('[data-test="message-toggle-m1"]').element);
    });
  });

  describe('retrying file details', () => {
    const retryButton = (w: VueWrapper) => w.get('[data-test="attachments-retry"]');
    const group = (w: VueWrapper) => w.get('[data-test="message-attachments-m1"]').element as HTMLElement;

    it('offers a ghost Retry beside the failure note, with a full accessible name', async () => {
      const client = stubClient();
      client.listAttachments.mockRejectedValue({ kind: 'storage_unavailable' });
      const w = mountReader(withFile(), { client: asClient(client) });
      await settle();
      expect(w.get('[data-test="attachments-load-error"]').text()).toBe('Could not load file details.');
      const retry = retryButton(w);
      expect(retry.text()).toBe('Retry');
      expect(retry.attributes('aria-label')).toBe('Retry loading file details');
      expect(retry.attributes('type')).toBe('button');
      expect(retry.attributes('aria-disabled')).toBeUndefined();
      // No new live region: the group holds only the existing note and the button.
      expect(w.get('[data-test="message-attachments-m1"]').findAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);
      expect(client.listAttachments).toHaveBeenCalledTimes(1);
    });

    it('asks again on click, stays mounted and aria-disabled while it waits, then replaces the note with the list and keeps focus in the group', async () => {
      const client = stubClient();
      client.listAttachments.mockRejectedValueOnce({ kind: 'storage_unavailable' });
      const w = mountReader(withFile(), { client: asClient(client) });
      await settle();
      const second = deferred<AttachmentDescriptor[]>();
      client.listAttachments.mockReturnValueOnce(second.promise);
      (retryButton(w).element as HTMLButtonElement).focus();
      expect(document.activeElement).toBe(retryButton(w).element);
      await retryButton(w).trigger('click');
      expect(client.listAttachments).toHaveBeenCalledTimes(2);
      expect(client.listAttachments).toHaveBeenLastCalledWith(withFile().ref);
      // Still the same mounted button, so focus does not drop to <body>.
      expect(retryButton(w).element).toBe(document.activeElement);
      expect(retryButton(w).attributes('aria-disabled')).toBe('true');
      expect(retryButton(w).attributes('disabled')).toBeUndefined();
      expect(retryButton(w).text()).toBe('Retrying…');
      expect(retryButton(w).attributes('aria-label')).toBe('Retrying…');
      // A click while retrying does not send a second request.
      await retryButton(w).trigger('click');
      expect(client.listAttachments).toHaveBeenCalledTimes(2);

      second.resolve([FILE]);
      await settle();
      expect(w.find('[data-test="attachments-retry"]').exists()).toBe(false);
      expect(w.find('[data-test="attachments-load-error"]').exists()).toBe(false);
      expect(w.get('[data-test="attachment-a1"]').text()).toContain('example.txt');
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(group(w));
      expect(group(w).getAttribute('tabindex')).toBe('-1');
      // Programmatic focus only: the group is not a tab stop.
      expect(group(w).tabIndex).toBe(-1);
      expect(client.listAttachments).toHaveBeenCalledTimes(2);
    });

    it('keeps the failure and the Retry when the retry fails too, and allows another try', async () => {
      const client = stubClient();
      client.listAttachments.mockRejectedValue({ kind: 'storage_unavailable' });
      const w = mountReader(withFile(), { client: asClient(client) });
      await settle();
      (retryButton(w).element as HTMLButtonElement).focus();
      await retryButton(w).trigger('click');
      await settle();
      expect(client.listAttachments).toHaveBeenCalledTimes(2);
      expect(w.get('[data-test="attachments-load-error"]').text()).toBe('Could not load file details.');
      expect(retryButton(w).text()).toBe('Retry');
      expect(retryButton(w).attributes('aria-disabled')).toBeUndefined();
      expect(retryButton(w).attributes('aria-label')).toBe('Retry loading file details');
      expect(document.activeElement).toBe(retryButton(w).element);
      await retryButton(w).trigger('click');
      await settle();
      expect(client.listAttachments).toHaveBeenCalledTimes(3);
    });

    it('does not take focus when the user moved elsewhere before the retry came back', async () => {
      const client = stubClient();
      client.listAttachments.mockRejectedValueOnce({ kind: 'storage_unavailable' });
      const w = mountReader(withFile(), { client: asClient(client) });
      await settle();
      const second = deferred<AttachmentDescriptor[]>();
      client.listAttachments.mockReturnValueOnce(second.promise);
      await retryButton(w).trigger('click');
      (w.get('[data-test="message-toggle-m1"]').element as HTMLElement).focus();
      second.resolve([FILE]);
      await settle();
      expect(w.find('[data-test="attachment-a1"]').exists()).toBe(true);
      expect(document.activeElement).toBe(w.get('[data-test="message-toggle-m1"]').element);
    });
  });

  it('ignores a late response for a conversation that is no longer displayed', async () => {
    const late = deferred<AttachmentDescriptor[]>();
    const client = stubClient();
    const forB: AttachmentDescriptor = { messageId: 'n1', attachmentId: 'b1', filename: 'for-b.txt', mimeType: 'text/plain', size: 5 };
    client.listAttachments.mockImplementation(((target: ConversationRef) =>
      (target.conversationId === 'c1' ? late.promise : Promise.resolve([forB]))) as never);
    const a = withFile('c1');
    const b = conversationOf('c2', [message('n1', 'Body', { hasAttachment: true })]);
    const w = mountReader(a, { client: asClient(client) });
    await settle();
    await show(w, b);
    expect(w.get('[data-test="attachment-b1"]').text()).toContain('for-b.txt');
    late.resolve([FILE]);
    await settle();
    // A's late list must not appear on B.
    expect(w.find('[data-test="attachment-a1"]').exists()).toBe(false);
    expect(w.get('[data-test="attachment-b1"]').text()).toContain('for-b.txt');
    // It is kept for A, so the revisit shows it without another fetch.
    await show(w, a);
    expect(w.get('[data-test="attachment-a1"]').text()).toContain('example.txt');
    expect(client.listAttachments).toHaveBeenCalledTimes(2);
  });

  it('renders file names as literal text and only inside expanded messages', async () => {
    const hostile: AttachmentDescriptor = { ...FILE, filename: '<img src=x onerror=alert(1)>.txt' };
    const client = stubClient([hostile, { ...FILE, messageId: 'm0', attachmentId: 'old', filename: 'older.txt' }]);
    const conversation = conversationOf('c1', [message('m0', 'Older', { hasAttachment: true }), message('m1', 'Body', { hasAttachment: true })]);
    const w = mountReader(conversation, { client: asClient(client) });
    await settle();
    expect(w.get('[data-test="attachment-a1"]').text()).toContain('<img src=x onerror=alert(1)>.txt');
    expect(w.get('.reader-scroll').find('img').exists()).toBe(false);
    // The collapsed older message shows no list until it is expanded.
    expect(w.find('[data-test="attachment-old"]').exists()).toBe(false);
    await w.get('[data-test="message-toggle-m0"]').trigger('click');
    expect(w.get('[data-test="attachment-old"]').text()).toContain('older.txt');
  });
});

describe('reader loading placeholder', () => {
  function mountLoading(props: Record<string, unknown> = {}): VueWrapper {
    wrapper = mount(ReaderView, {
      props: { conversation: null, state: 'loading', error: null, commandInFlight: false, openRef: null, ...props },
      attachTo: document.body,
    });
    return wrapper;
  }

  it('keeps the exact status text and adds a static, hidden placeholder of the loaded shape', async () => {
    const w = mountLoading();
    await settle();
    expect(w.get('[data-test="reader-loading"]').text()).toBe('Loading conversation…');
    expect(w.get('[data-test="reader-loading"]').attributes('role')).toBe('status');
    const skeleton = w.get('[data-test="reader-skeleton"]');
    expect(skeleton.attributes('aria-hidden')).toBe('true');
    // Subject bar plus message rows; no text of its own for assistive tech.
    expect(skeleton.text()).toBe('');
    expect(skeleton.findAll('.reader-skeleton-row').length).toBeGreaterThanOrEqual(3);
    // Without an identity the subject slot is a hidden bar before the status line, outside the rows.
    const bar = w.get('[data-test="reader-skeleton-subject"]');
    expect(bar.attributes('aria-hidden')).toBe('true');
    expect(bar.element.tagName).toBe('H2');
    expect(bar.classes()).toContain('reader-subject');
    expect(skeleton.find('.reader-skeleton-subject').exists()).toBe(false);
    expect(w.find('[data-test="reader-loading-subject"]').exists()).toBe(false);
  });

  it('with a known row identity shows the subject and sender, and only the rows as placeholder', async () => {
    const w = mountLoading({ loadingIdentity: { subject: 'Quarterly plan', sender: 'Ada Fixture', at: '2026-11-06T10:00:00Z' } });
    await settle();
    expect(w.get('[data-test="reader-loading-subject"]').text()).toBe('Quarterly plan');
    expect(w.get('[data-test="reader-loading-sender"]').text()).toBe('Ada Fixture');
    const skeleton = w.get('[data-test="reader-skeleton"]');
    expect(w.find('[data-test="reader-skeleton-subject"]').exists()).toBe(false);
    expect(skeleton.findAll('.reader-skeleton-row').length).toBeGreaterThanOrEqual(3);
  });

  describe('does not move the pane: the status shares the identity line and adds no flow height of its own', () => {
    const identity = { subject: 'Quarterly plan', sender: 'Ada Fixture', at: '2026-11-06T10:00:00Z' };
    const line = (w: VueWrapper) => w.get('[data-test="reader-loading-line"]');

    it('folds the sender, date and status into ONE line inside the stage, before the rows, with one role=status', async () => {
      const w = mountLoading({ loadingIdentity: identity });
      await settle();
      const stage = w.get('[data-test="reader-loading-stage"]');
      expect(stage.element.firstElementChild).toBe(line(w).element);
      expect(stage.element.lastElementChild).toBe(w.get('[data-test="reader-skeleton"]').element);
      const l = line(w);
      expect(l.find('[data-test="reader-loading-sender"]').exists()).toBe(true);
      expect(l.find('time').exists()).toBe(true);
      expect(l.get('[data-test="reader-loading"]').text()).toBe('Loading conversation…');
      expect(l.get('[data-test="reader-loading"]').attributes('role')).toBe('status');
      expect(w.findAll('.reader-scroll [role="status"], .reader-scroll [role="alert"], .reader-scroll [aria-live]')).toHaveLength(1);
      // The rows stay hidden from assistive technology and the line is not inside them.
      expect(w.get('[data-test="reader-skeleton"]').find('[data-test="reader-loading"]').exists()).toBe(false);
    });

    it('without read controls the line is an overlay on the first row (no flow height)', async () => {
      const w = mountLoading({ loadingIdentity: identity });
      await settle();
      expect(w.get('[data-test="reader-loading-stage"]').classes()).toContain('is-overlay');
      expect(line(w).classes()).not.toContain('reader-meta-row');
    });

    it('with read controls the line takes the meta row slot the loaded reader will use', async () => {
      const w = mountLoading({ loadingIdentity: identity, showReadControls: true });
      await settle();
      expect(w.get('[data-test="reader-loading-stage"]').classes()).not.toContain('is-overlay');
      expect(line(w).classes()).toContain('reader-meta-row');
      const readOnly = mountLoading({ loadingIdentity: identity, readOnly: true });
      await settle();
      expect(readOnly.get('[data-test="reader-loading-line"]').classes()).toContain('reader-meta-row');
    });
  });
});
