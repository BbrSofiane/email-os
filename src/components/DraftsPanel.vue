<script setup lang="ts">
import type { DraftContent, DraftRef, DraftSource, DraftSummary, MailError } from '../lib/ipc/client';
import { describeDraftError } from '../lib/draft-errors';
import DraftEditorCore from './DraftEditorCore.vue';

const props = withDefaults(defineProps<{
  summaries: DraftSummary[];
  activeRef: DraftRef | null;
  source: DraftSource | null;
  content: DraftContent;
  status: string;
  visible: boolean;
  suspendedEditor: boolean;
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
  listError: MailError | null;
  subscriptionError: MailError | null;
  closeError: string | null;
  closeRetryAvailable: boolean;
  closeSetupError: string | null;
  /** Human-readable reply target shown as "Draft to {label}"; null hides the line. */
  recipientLabel?: string | null;
}>(), { recipientLabel: null });

const emit = defineEmits<{
  newDraft: [];
  openDraft: [ref: DraftRef];
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
  retryDraftSubscription: [];
  retryClose: [];
  cancelReplyPreparation: [];
  retryCloseSetup: [];
}>();

function describe(error: MailError): string {
  return describeDraftError(error);
}

function onSetField(field: keyof DraftContent, value: string): void {
  emit('setField', field, value);
}
</script>

<template>
  <section class="drafts-pane" aria-label="Local drafts" data-test="drafts-pane">
    <div class="draft-list">
      <div class="draft-list-heading">
        <h2>Drafts</h2>
        <button type="button" data-test="new-draft" :disabled="props.closing || props.transitioning" @click="emit('newDraft')">New draft</button>
      </div>
      <p class="draft-local-note" role="note">Drafts are local to this device and account. No drafts are sent to a mail provider.</p>
      <p v-if="props.suspendedEditor" role="alert" data-test="suspended-editor">
        An editor from another account is suspended in memory. Its text is hidden and will not be saved to this account; return to the original account to resolve it.
      </p>
      <p v-if="props.closeError && !props.visible" role="alert" data-test="draft-close-error">{{ props.closeError }}</p>
      <p v-if="props.closeSetupError" role="alert" data-test="draft-close-setup-error">
        Close protection could not be initialized: {{ props.closeSetupError }}
        <button type="button" data-test="retry-close-setup" @click="emit('retryCloseSetup')">Retry close protection</button>
      </p>
      <button v-if="props.closeRetryAvailable" type="button" data-test="retry-close" @click="emit('retryClose')">Retry close request</button>
      <p v-if="props.listError" role="alert" data-test="draft-list-error">Could not load drafts: {{ describe(props.listError) }}</p>
      <p v-if="props.subscriptionError" role="alert" data-test="draft-subscription-error">
        Draft change notifications are unavailable; this list will refresh on reconnect and after local saves. {{ describe(props.subscriptionError) }}
        <button type="button" data-test="retry-draft-subscription" @click="emit('retryDraftSubscription')">Retry draft updates</button>
      </p>
      <p v-if="props.createError && !props.visible" role="alert" data-test="draft-open-error">{{ describe(props.createError) }}</p>
      <p v-else-if="props.summaries.length === 0" data-test="draft-list-empty">No local drafts.</p>
      <ul v-else data-test="draft-list">
        <li v-for="draft in props.summaries" :key="`${draft.ref.accountId}:${draft.ref.draftId}`">
          <button
            type="button"
            class="draft-row"
            :data-test="`open-draft-${draft.ref.draftId}`"
            :disabled="props.closing || props.transitioning"
            @click="emit('openDraft', draft.ref)"
          >
            <strong>{{ draft.subject || '(no subject)' }}</strong>
            <span>{{ draft.to || '(no recipient)' }}</span>
            <small>Revision {{ draft.revision }} · {{ draft.source.kind === 'reply' ? 'Reply' : 'New message' }}</small>
          </button>
        </li>
      </ul>
    </div>

    <section v-if="props.visible" class="composer" aria-label="Plain-text draft editor" data-test="composer">
      <DraftEditorCore
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
            <h2>{{ props.source?.kind === 'reply' ? 'Reply draft' : 'New local draft' }}</h2>
          </header>
          <p v-if="props.source?.kind === 'reply' && props.recipientLabel" class="draft-recipient" data-test="draft-recipient-label"><strong class="draft-flag">Draft</strong> to {{ props.recipientLabel }}</p>
        </template>
        <template #context>
          <p v-if="props.source?.kind === 'reply'" class="reply-source" data-test="reply-source">
            Reply source is fixed: {{ props.source.conversation.conversationId }} · {{ props.source.sourceMessageId }}
          </p>
        </template>
      </DraftEditorCore>
    </section>
  </section>
</template>

<style scoped>
/* Composer reply-target line (Superhuman-style "Draft to {name}"); the flag
   word itself uses the global .draft-flag style. */
.draft-recipient {
  margin: 0.3rem 0;
  font-size: var(--type-body);
  color: var(--text-primary);
}
</style>
