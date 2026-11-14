<script setup lang="ts">
/**
 * Inline reply composer docked at the bottom of the open reader (Superhuman
 * reply shot). The thread stays visible above it; this pane only edits the
 * local plain-text draft through the shared `useDrafts` state wired by App.
 * The editor body is the shared DraftEditorCore; this surface supplies the
 * docked shell, the compact "Reply draft to {recipient}" heading (from the
 * actual To) and the read-only quoted context.
 *
 * Frozen draft contract (vertical-slice-04): the quoted latest message is a
 * READ-ONLY context block — it is never inserted into `bodyText`, which stays
 * blank on prepare. No Send/send-later/AI/attachments/rich text/Bcc/reply-all:
 * the footer offers "Save and close" and "Discard…" only. All text is rendered
 * through interpolation; no v-html. The fixed reply source is exposed to tests
 * and tools as data attributes only; opaque provider IDs are never shown.
 */
import { computed } from 'vue';
import type { DraftContent, DraftRef, DraftSource, MailError } from '../lib/ipc/client';
import DraftEditorCore from './DraftEditorCore.vue';

const props = defineProps<{
  /** Heading name while To is the default sender: displayName ?? mailbox of the latest message. */
  recipientLabel: string;
  /** The latest message sender's mailbox: the default To. The recipient row shows the name only while To still equals it. */
  recipientMailbox?: string | null;
  /** Read-only quoted snippet of the latest message plain-text body. */
  quotedSnippet: string;
  activeRef: DraftRef | null;
  source: DraftSource | null;
  content: DraftContent;
  status: string;
  visible: boolean;
  creating: boolean;
  saving: boolean;
  conflict: boolean;
  error: MailError | null;
  createError: MailError | null;
  deleting: boolean;
  closing: boolean;
  transitioning: boolean;
  deletePending: boolean;
  confirmDiscard: boolean;
  discardBusy: boolean;
  confirmReload: boolean;
  copyPending: boolean;
  recoveryRequired: boolean;
  canCancelReplyPreparation: boolean;
  closeError: string | null;
}>();

const emit = defineEmits<{
  closeEditor: [];
  setField: [field: keyof DraftContent, value: string];
  retry: [];
  askDiscard: [];
  confirmDiscard: [];
  cancelDiscard: [];
  askReload: [];
  confirmReload: [];
  cancelReload: [];
  saveAsNew: [];
  cancelReplyPreparation: [];
}>();

function onSetField(field: keyof DraftContent, value: string): void {
  emit('setField', field, value);
}

/**
 * The heading names who the reply goes to NOW, from the actual `content.to`,
 * not from the latest message's sender (Reply-To can differ on list mail).
 * - The sender's display name while To is empty and the draft is being
 *   created, or while To equals the sender mailbox (case-insensitive).
 * - Otherwise the first non-empty entry of To (split on `,` or `;`), plus
 *   ` +N` for N more entries. The full To goes in the title.
 * - Nothing (`null`) for a ready draft with no recipient.
 */
const headingTarget = computed<{ text: string } | null>(() => {
  const to = props.content.to.trim();
  const entries = to.split(/[,;]/).map((entry) => entry.trim()).filter((entry) => entry !== '');
  const unprepared = props.creating || !props.activeRef?.draftId;
  const sender = props.recipientMailbox?.trim().toLowerCase() ?? '';
  if (entries.length === 0) return unprepared ? { text: props.recipientLabel } : null;
  if (sender !== '' && to.toLowerCase() === sender) return { text: props.recipientLabel };
  return { text: entries.length > 1 ? `${entries[0]} +${entries.length - 1}` : entries[0]! };
});
</script>

<template>
  <section class="reply-composer" aria-label="Inline reply draft composer" data-test="reply-composer">
    <section v-if="props.visible" class="composer" aria-label="Plain-text draft editor" data-test="composer">
      <DraftEditorCore
        autofocus="body"
        variant="reply"
        :recipient-label="props.recipientLabel"
        :recipient-mailbox="props.recipientMailbox ?? null"
        :active-ref="props.activeRef"
        :source="props.source"
        :content="props.content"
        :status="props.status"
        :creating="props.creating"
        :saving="props.saving"
        :conflict="props.conflict"
        :error="props.error"
        :create-error="props.createError"
        :deleting="props.deleting"
        :closing="props.closing"
        :transitioning="props.transitioning"
        :delete-pending="props.deletePending"
        :confirm-discard="props.confirmDiscard"
        :discard-busy="props.discardBusy"
        :confirm-reload="props.confirmReload"
        :copy-pending="props.copyPending"
        :recovery-required="props.recoveryRequired"
        :can-cancel-reply-preparation="props.canCancelReplyPreparation"
        :close-error="props.closeError"
        @close-editor="emit('closeEditor')"
        @set-field="onSetField"
        @retry="emit('retry')"
        @ask-discard="emit('askDiscard')"
        @confirm-discard="emit('confirmDiscard')"
        @cancel-discard="emit('cancelDiscard')"
        @ask-reload="emit('askReload')"
        @confirm-reload="emit('confirmReload')"
        @cancel-reload="emit('cancelReload')"
        @save-as-new="emit('saveAsNew')"
        @cancel-reply-preparation="emit('cancelReplyPreparation')"
      >
        <template #header>
          <header class="composer-heading">
            <h2>Reply draft<span v-if="headingTarget" class="reply-to" :title="props.content.to.trim() === '' ? undefined : props.content.to"> to <span data-test="draft-recipient-label">{{ headingTarget.text }}</span></span></h2>
          </header>
        </template>
        <template #context>
          <!-- The fixed reply source: attributes only, never visible text. -->
          <span
            v-if="props.source?.kind === 'reply'"
            hidden
            data-test="reply-source"
            :data-source-conversation="props.source.conversation.conversationId"
            :data-source-message="props.source.sourceMessageId"
          ></span>
          <!-- Read-only quoted context of the latest message. It is display-only:
               it is never part of bodyText and the saved reply body stays blank. -->
          <blockquote class="reply-quoted" data-test="reply-quoted-context" aria-label="Quoted latest message (read-only)">{{ props.quotedSnippet }}</blockquote>
        </template>
      </DraftEditorCore>
    </section>
  </section>
</template>

<style scoped>
/* Docked reply composer on the raised surface. Full 1px border, no accent
   side stripe. The shell scrolls only when the thread and composer genuinely
   do not fit; the body textarea, not the header stack, takes the space. */
.reply-composer {
  flex: 0 0 auto;
  min-height: 0;
  /* Same inline margins as the undocked .compose-card (50px start, 24px end,
     12px bottom), so a docked reply sits on the content inset. */
  margin: 6px var(--content-inset-end) 12px var(--content-inset);
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-primary);
  font-size: var(--type-body);
  overflow-y: auto;
  max-height: 60%;
}

.composer {
  min-width: 0;
  padding: var(--composer-padding);
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.reply-to {
  color: var(--text-secondary);
  font-weight: var(--weight-regular);
  overflow-wrap: anywhere;
}

/* Read-only quoted context: plain text only, never editable, never part of
   the draft body. UI face at the body size, clamped to three lines so it can
   never push the body down; the full snippet stays in the DOM text. */
.reply-quoted {
  margin: 0.3rem 0;
  padding: 0.1rem 0.5rem;
  border-left: 2px solid var(--rule);
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: var(--type-body);
  line-height: var(--leading-ui);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}
</style>
