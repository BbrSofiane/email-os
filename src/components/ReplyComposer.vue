<script setup lang="ts">
/**
 * Inline reply composer docked at the bottom of the open reader (Superhuman
 * reply shot). The thread stays visible above it; this pane only edits the
 * local plain-text draft through the shared `useDrafts` state wired by App.
 * The editor body is the shared DraftEditorCore; this surface supplies the
 * docked shell, the "Draft to {sender}" header and the read-only quoted
 * context.
 *
 * Frozen draft contract (vertical-slice-04): the quoted latest message is a
 * READ-ONLY context block — it is never inserted into `bodyText`, which stays
 * blank on prepare. No Send/send-later/AI/attachments/rich text/Bcc/reply-all:
 * the footer offers "Close editor" and "Discard…" only. All text is rendered
 * through interpolation; no v-html.
 */
import type { DraftContent, DraftRef, DraftSource, MailError } from '../lib/ipc/client';
import DraftEditorCore from './DraftEditorCore.vue';

const props = defineProps<{
  /** "Draft to {sender}" header label: displayName ?? mailbox of the latest message. */
  recipientLabel: string;
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
</script>

<template>
  <section class="reply-composer" aria-label="Inline reply draft composer" data-test="reply-composer">
    <section v-if="props.visible" class="composer" aria-label="Plain-text draft editor" data-test="composer">
      <DraftEditorCore
        autofocus="body"
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
            <span class="draft-flag" data-test="draft-flag">Draft</span>
            <h2>Reply draft <span class="reply-to">to <span data-test="draft-recipient-label">{{ props.recipientLabel }}</span></span></h2>
          </header>
        </template>
        <template #context>
          <p v-if="props.source?.kind === 'reply'" class="reply-source" data-test="reply-source">
            Reply source is fixed: {{ props.source.conversation.conversationId }} · {{ props.source.sourceMessageId }}
          </p>
          <!-- Read-only quoted context of the latest message. It is display-only:
               it is never part of bodyText and the saved reply body stays blank. -->
          <blockquote class="reply-quoted" data-test="reply-quoted-context" aria-label="Quoted latest message (read-only)">{{ props.quotedSnippet }}</blockquote>
        </template>
      </DraftEditorCore>
    </section>
  </section>
</template>

<style scoped>
/* Docked reply composer on the raised surface. Full 1px border — no accent
   side stripe; the "Draft" flag in the header carries the state. */
.reply-composer {
  flex: 0 0 auto;
  min-height: 0;
  margin-top: 0.5rem;
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-primary);
  font-size: var(--type-body);
  overflow-y: auto;
  max-height: 45%;
}

.composer {
  min-width: 0;
  padding: 0.4rem 0.6rem;
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
   the draft body. */
.reply-quoted {
  margin: 0.3rem 0;
  padding: 0.3rem 0.5rem;
  border-left: 2px solid var(--rule);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--type-mono);
  line-height: var(--leading-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
</style>
