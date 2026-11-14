/**
 * Contact context: who the contact pane, the reader's loading identity and the
 * compose card's heading talk about, moved verbatim out of App.vue. Only exact
 * known fields, only the matching surface: the focused row's primary
 * correspondent, the reader's active message sender (with the reader's
 * temporary participant override), the loading row's identity, and the reply
 * draft's target. Pure views over the mailbox and the active draft; the
 * focus handoff when the column collapses stays with the owner (it needs DOM
 * refs).
 */
import { computed, ref, type ComputedRef } from 'vue';
import type { ConversationRef } from '../lib/ipc/client';
import { sameConversation, type Mailbox } from './useMailbox';
import type { useDrafts } from './useDrafts';

export type ContactContext = 'focused' | 'open';
export interface ContactInfo { displayName: string | null; mailbox: string }

export interface ContactContextDeps {
  mailbox: Mailbox;
  drafts: ReturnType<typeof useDrafts>;
  readerOpen: ComputedRef<boolean>;
  accountReady: ComputedRef<boolean>;
}

export function useContactContext({ mailbox, drafts, readerOpen, accountReady }: ContactContextDeps) {
  const readerActiveMessageId = ref<string | null>(null);
  /** Temporary participant hover/focus context from the reader. */
  const contactOverride = ref<
    { ref: ConversationRef; messageId: string; displayName: string | null; mailbox: string } | null
  >(null);

  // ---------------------------------------------------------------------------
  // Contact context data: only exact known fields, only the matching surface
  // ---------------------------------------------------------------------------

  const listContact = computed<ContactInfo | null>(() => {
    // A non-ready list never supplies stale contact targets.
    if (mailbox.listState.value !== 'ready') return null;
    const primary = mailbox.focusedSummary.value?.primaryCorrespondent;
    return primary ? { displayName: primary.displayName, mailbox: primary.mailbox } : null;
  });

  const readerContact = computed<ContactInfo | null>(() => {
    const conversation = mailbox.conversation.value;
    if (!conversation || mailbox.detailState.value !== 'ready') return null;
    if (!sameConversation(conversation.ref, mailbox.openRef.value)) return null;
    // Baseline: the sender of the focused (active) message; without one, the
    // latest displayed message. Hover/focus overrides are applied in `contact`.
    const activeId = readerActiveMessageId.value;
    const active = activeId ? conversation.messages.find((message) => message.id === activeId) ?? null : null;
    const message = active ?? conversation.messages[conversation.messages.length - 1] ?? null;
    return message ? { displayName: message.from.displayName, mailbox: message.from.mailbox } : null;
  });

  /** The list row of the open reference: the list's own, truthful identity data. */
  const openRow = computed(() => {
    const opened = mailbox.openRef.value;
    return opened ? mailbox.conversations.value.find((row) => sameConversation(row.ref, opened)) ?? null : null;
  });
  const readerLoading = computed(() => readerOpen.value && mailbox.detailState.value === 'loading');
  /** What the reader may say about a still-loading target, from the list row only. */
  const readerLoadingIdentity = computed(() => {
    const row = readerLoading.value ? openRow.value : null;
    if (!row) return null;
    const primary = row.primaryCorrespondent;
    return {
      subject: row.subject,
      sender: primary ? primary.displayName ?? primary.mailbox : null,
      at: row.lastMessageAt ?? null,
    };
  });

  const contact = computed<ContactInfo | null>(() => {
    if (!readerOpen.value) return listContact.value;
    // While the target loads, the list row's sender is the only truthful source.
    if (readerLoading.value) {
      const primary = mailbox.listState.value === 'ready' ? openRow.value?.primaryCorrespondent : undefined;
      return primary ? { displayName: primary.displayName, mailbox: primary.mailbox } : null;
    }
    // A participant override applies only while the referenced message still
    // exists on the open conversation: late blur/leave events, background
    // removals, and account changes cannot leak a stale contact.
    const override = contactOverride.value;
    if (override
      && sameConversation(override.ref, mailbox.openRef.value)
      && mailbox.conversation.value?.messages.some((message) => message.id === override.messageId)
    ) {
      return { displayName: override.displayName, mailbox: override.mailbox };
    }
    return readerContact.value;
  });
  const contactContext = computed<ContactContext>(() => (readerOpen.value ? 'open' : 'focused'));

  // Reply-target resolution for an active reply draft editor, for the compose
  // card's heading (the contact pane shows no compose line: it would move its
  // pinned name and email lines). While
  // the reader is open on the source conversation, the latest message's sender
  // is the exact known target; otherwise the draft's current raw To text is the
  // only honest fallback. No target is guessed from participants or names.
  const composeTarget = computed<ContactInfo | null>(() => {
    const source = drafts.activeSource.value;
    if (!source || source.kind !== 'reply') return null;
    const open = mailbox.conversation.value;
    if (readerOpen.value && open && sameConversation(open.ref, source.conversation)) {
      const latest = open.messages[open.messages.length - 1];
      if (latest) return { displayName: latest.from.displayName, mailbox: latest.from.mailbox };
    }
    const to = drafts.content.value.to;
    return to.trim() ? { displayName: null, mailbox: to } : null;
  });
  // A ready list with no rows, no open reader and no reply target has no conversation to have a contact: the
  // column takes no width (the list does) and the rail has no Contact button. While loading or failed, rows may
  // still arrive, so nothing collapses then. With rows and a selected conversation nothing changes.
  const contactCollapsed = computed(() => accountReady.value && mailbox.listState.value === 'ready'
    && mailbox.conversations.value.length === 0 && !readerOpen.value && !composeTarget.value);

  const composeRecipientLabel = computed<string | null>(() => {
    const target = composeTarget.value;
    return target ? (target.displayName ?? target.mailbox) : null;
  });
  /** The inline card's name: "New Message", or the reply draft's own title when a reply is edited there. */
  const cardTitle = computed(() => drafts.activeSource.value?.kind !== 'reply' ? 'New Message'
    : composeRecipientLabel.value ? `Reply draft to ${composeRecipientLabel.value}` : 'Reply draft');

  function onReaderActiveMessage(messageId: string | null): void {
    readerActiveMessageId.value = messageId;
    // A new focused message restarts participant context from the baseline,
    // EXCEPT when focus landed directly on a participant of that message: the
    // reader emits the participant override BEFORE the active-message event in
    // that case, so an override matching the newly focused message and the
    // currently open conversation survives. Every other override (older message,
    // other conversation/account, cleared focus) is discarded.
    const override = contactOverride.value;
    if (messageId === null
      || !override
      || override.messageId !== messageId
      || !sameConversation(override.ref, mailbox.openRef.value)) {
      contactOverride.value = null;
    }
  }

  function onReaderContactOverride(
    override: { ref: ConversationRef; messageId: string; displayName: string | null; mailbox: string } | null,
  ): void {
    contactOverride.value = override;
  }

  return { readerLoading, readerLoadingIdentity, contact, contactContext, contactCollapsed, composeRecipientLabel, cardTitle, onReaderActiveMessage, onReaderContactOverride };
}
