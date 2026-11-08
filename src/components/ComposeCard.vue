<script setup lang="ts">
/**
 * Inline new-message compose card: an in-flow card in the central pane (the
 * area where the inbox list normally is) — or docked at the bottom of the
 * reader pane while a reader is open — never a modal overlay. There is no
 * backdrop and no dimming: the rail, header and contact pane stay visible and
 * interactive. The editor body (fields, status, errors, conflict/recovery,
 * discard-confirm, footer) is the shared DraftEditorCore; this surface only
 * supplies the card shell and the "New Message" header. No Send action exists.
 */
import type { DraftContent, DraftRef, DraftSource, MailError } from '../lib/ipc/client';
import DraftEditorCore from './DraftEditorCore.vue';

defineProps<{
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
  <section class="compose-card" aria-label="New Message" data-test="compose-card">
    <DraftEditorCore
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
          <h2>New Message</h2>
        </header>
      </template>
    </DraftEditorCore>
  </section>
</template>
