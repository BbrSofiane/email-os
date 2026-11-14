/**
 * `useContactContext` in isolation: a stub mailbox and draft of plain refs with
 * synthetic people. Covers which surface supplies the contact, the reader's
 * participant override rules, the loading identity, the reply target and the
 * collapse condition.
 */
import { describe, expect, it } from 'vitest';
import { computed, effectScope, ref } from 'vue';
import { useContactContext } from '../../src/composables/useContactContext';
import type { Mailbox } from '../../src/composables/useMailbox';

const ref1 = { accountId: 'acct', conversationId: 'c1' };
const person = (mailbox: string, displayName: string | null = null) => ({ displayName, mailbox });
const message = (id: string, from: { displayName: string | null; mailbox: string }) => ({ id, from });

function setup() {
  const openRef = ref<typeof ref1 | null>(null);
  const mailbox = {
    listState: ref('ready'),
    detailState: ref('ready'),
    openRef,
    conversations: ref<unknown[]>([{ ref: ref1, subject: 'Synthetic subject', lastMessageAt: '2026-01-15T00:00:00Z', primaryCorrespondent: person('row@example.test', 'Row Person'), participants: [] }]),
    focusedSummary: ref<unknown>({ primaryCorrespondent: person('focus@example.test', 'Focus Person') }),
    conversation: ref<unknown>(null),
  };
  const drafts = { activeSource: ref<unknown>(null), content: ref({ to: '' }) };
  const readerOpen = computed(() => openRef.value !== null);
  const accountReady = ref(true);
  const scope = effectScope();
  const contact = scope.run(() => useContactContext({
    mailbox: mailbox as unknown as Mailbox,
    drafts: drafts as never,
    readerOpen,
    accountReady: computed(() => accountReady.value),
  }))!;
  const openReader = (messages = [message('m1', person('first@example.test', 'First')), message('m2', person('second@example.test'))]) => {
    openRef.value = ref1;
    mailbox.conversation.value = { ref: ref1, messages };
  };
  return { contact, mailbox, drafts, accountReady, openRef, openReader, stop: () => scope.stop() };
}

describe('useContactContext', () => {
  it('uses the focused row while the list is ready, and nothing while it is not', () => {
    const { contact, mailbox, stop } = setup();
    expect(contact.contact.value).toEqual({ displayName: 'Focus Person', mailbox: 'focus@example.test' });
    expect(contact.contactContext.value).toBe('focused');
    mailbox.listState.value = 'loading';
    expect(contact.contact.value).toBeNull();
    stop();
  });

  it('uses the latest message sender in the reader, or the active message once one is reported', () => {
    const { contact, openReader, stop } = setup();
    openReader();
    expect(contact.contactContext.value).toBe('open');
    expect(contact.contact.value).toEqual({ displayName: null, mailbox: 'second@example.test' });
    contact.onReaderActiveMessage('m1');
    expect(contact.contact.value).toEqual({ displayName: 'First', mailbox: 'first@example.test' });
    stop();
  });

  it('applies a participant override only for an existing message of the open conversation', () => {
    const { contact, openReader, stop } = setup();
    openReader();
    contact.onReaderContactOverride({ ref: ref1, messageId: 'm2', displayName: 'Hover', mailbox: 'hover@example.test' });
    expect(contact.contact.value).toEqual({ displayName: 'Hover', mailbox: 'hover@example.test' });
    contact.onReaderContactOverride({ ref: ref1, messageId: 'gone', displayName: 'Stale', mailbox: 'stale@example.test' });
    expect(contact.contact.value).toEqual({ displayName: null, mailbox: 'second@example.test' });
    contact.onReaderContactOverride({ ref: { ...ref1, conversationId: 'other' }, messageId: 'm2', displayName: 'Other', mailbox: 'other@example.test' });
    expect(contact.contact.value).toEqual({ displayName: null, mailbox: 'second@example.test' });
    stop();
  });

  it('a new active message drops the override unless it was raised for that very message', () => {
    const { contact, openReader, stop } = setup();
    openReader();
    contact.onReaderContactOverride({ ref: ref1, messageId: 'm1', displayName: 'Hover', mailbox: 'hover@example.test' });
    contact.onReaderActiveMessage('m1'); // focus landed on the participant of m1: survives
    expect(contact.contact.value).toEqual({ displayName: 'Hover', mailbox: 'hover@example.test' });
    contact.onReaderActiveMessage('m2'); // another message: discarded
    expect(contact.contact.value).toEqual({ displayName: null, mailbox: 'second@example.test' });
    contact.onReaderContactOverride({ ref: ref1, messageId: 'm2', displayName: 'Hover', mailbox: 'hover@example.test' });
    contact.onReaderActiveMessage(null); // cleared focus: discarded
    expect(contact.contact.value).toEqual({ displayName: null, mailbox: 'second@example.test' });
    stop();
  });

  it('names a still-loading reader from the list row only', () => {
    const { contact, mailbox, openRef, stop } = setup();
    openRef.value = ref1;
    mailbox.detailState.value = 'loading';
    expect(contact.readerLoading.value).toBe(true);
    expect(contact.readerLoadingIdentity.value).toEqual({ subject: 'Synthetic subject', sender: 'Row Person', at: '2026-01-15T00:00:00Z' });
    expect(contact.contact.value).toEqual({ displayName: 'Row Person', mailbox: 'row@example.test' });
    mailbox.detailState.value = 'ready';
    expect(contact.readerLoadingIdentity.value).toBeNull();
    stop();
  });

  it('heads a reply draft from the open source sender, else from the raw To text', () => {
    const { contact, drafts, openReader, stop } = setup();
    expect(contact.cardTitle.value).toBe('New Message');
    drafts.activeSource.value = { kind: 'reply', conversation: ref1 };
    drafts.content.value = { to: '  ' };
    expect(contact.composeRecipientLabel.value).toBeNull();
    expect(contact.cardTitle.value).toBe('Reply draft');
    drafts.content.value = { to: 'typed@example.test' };
    expect(contact.composeRecipientLabel.value).toBe('typed@example.test');
    expect(contact.cardTitle.value).toBe('Reply draft to typed@example.test');
    openReader();
    expect(contact.composeRecipientLabel.value).toBe('second@example.test');
    stop();
  });

  it('collapses the column only for a ready account with a ready, empty list, no reader and no reply target', () => {
    const { contact, mailbox, accountReady, drafts, openReader, stop } = setup();
    expect(contact.contactCollapsed.value).toBe(false);
    mailbox.conversations.value = [];
    expect(contact.contactCollapsed.value).toBe(true);
    mailbox.listState.value = 'loading';
    expect(contact.contactCollapsed.value).toBe(false);
    mailbox.listState.value = 'ready';
    accountReady.value = false;
    expect(contact.contactCollapsed.value).toBe(false);
    accountReady.value = true;
    drafts.activeSource.value = { kind: 'reply', conversation: ref1 };
    drafts.content.value = { to: 'typed@example.test' };
    expect(contact.contactCollapsed.value).toBe(false);
    drafts.activeSource.value = null;
    expect(contact.contactCollapsed.value).toBe(true);
    openReader();
    expect(contact.contactCollapsed.value).toBe(false);
    stop();
  });
});
