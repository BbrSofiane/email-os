<script setup lang="ts">
/**
 * Inline new-message compose card: an in-flow card in the central pane (the
 * area where the inbox list normally is) — or docked at the bottom of the
 * reader pane while a reader is open — never a modal overlay. There is no
 * backdrop and no dimming: the rail, header and contact pane stay visible and
 * interactive. The editor body (fields, status, errors, conflict/recovery,
 * discard-confirm, footer) is the shared DraftEditorCore; this surface only
 * supplies the card shell and its header: "New Message", or the reply draft's
 * own title when a reply draft is edited here because its source conversation
 * cannot host it (then one Amber Notice line says so, with the terse reason as
 * visible text and the full sentence in the title).
 * No Send action exists.
 */
import { computed } from 'vue';
import type { DraftContent, DraftRef, DraftSource, MailError } from '../lib/ipc/client';
import { replyReasonLabel } from '../lib/reply-context';
import DraftEditorCore from './DraftEditorCore.vue';

const props = defineProps<{
  /** Reply drafts only: the human-readable target shown as "Reply draft to {label}"; null hides it. */
  recipientLabel?: string | null;
  /** Reply drafts only: why the draft is edited here and not in its thread. */
  notice?: string | null;
  activeRef: DraftRef | null;
  source: DraftSource | null;
  content: DraftContent;
  status: string;
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

/** The card's accessible name: "New Message", or the reply draft's own title. */
const title = computed(() => props.source?.kind !== 'reply' ? 'New Message'
  : props.recipientLabel ? `Reply draft to ${props.recipientLabel}` : 'Reply draft');

/** One Amber line: the terse reason is visible text; the full sentence stays in the title. */
const noticeLine = computed(() => props.notice
  ? `Source conversation unavailable: ${replyReasonLabel(props.notice)}. Editing locally; nothing is sent.`
  : '');

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
  <section class="compose-card" :aria-label="title" data-test="compose-card">
    <DraftEditorCore
      data-test="composer"
      autofocus="to"
      variant="new"
      :active-ref="activeRef"
      :source="source"
      :content="content"
      :status="status"
      :creating="creating"
      :saving="saving"
      :conflict="conflict"
      :error="error"
      :create-error="createError"
      :deleting="deleting"
      :closing="closing"
      :transitioning="transitioning"
      :delete-pending="deletePending"
      :confirm-discard="confirmDiscard"
      :discard-busy="discardBusy"
      :confirm-reload="confirmReload"
      :copy-pending="copyPending"
      :recovery-required="recoveryRequired"
      :can-cancel-reply-preparation="canCancelReplyPreparation"
      :close-error="closeError"
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
          <h2 v-if="source?.kind === 'reply' && recipientLabel">Reply draft <span class="reply-to">to <span data-test="draft-recipient-label">{{ recipientLabel }}</span></span></h2>
          <h2 v-else-if="source?.kind === 'reply'">Reply draft</h2>
          <h2 v-else>New Message</h2>
        </header>
        <!-- Honest state: the reply cannot be shown in its thread, so it is edited here. -->
        <p v-if="notice" class="compose-card-notice" role="note" data-test="compose-card-notice" :title="notice">{{ noticeLine }}</p>
      </template>
      <template #context>
        <!-- The fixed reply source: attributes only, never visible text. -->
        <span
          v-if="source?.kind === 'reply'"
          hidden
          data-test="reply-source"
          :data-source-conversation="source.conversation.conversationId"
          :data-source-message="source.sourceMessageId"
        ></span>
      </template>
    </DraftEditorCore>
  </section>
</template>
