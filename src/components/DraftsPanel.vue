<script setup lang="ts">
import type { DraftContent, DraftRef, DraftSource, DraftSummary, MailError } from '../lib/ipc/client';

const props = defineProps<{
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
  confirmReload: boolean;
  copyPending: boolean;
  canCancelReplyPreparation: boolean;
  listError: MailError | null;
  subscriptionError: MailError | null;
  closeError: string | null;
  closeRetryAvailable: boolean;
  closeSetupError: string | null;
}>();

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

function fieldsDisabled(): boolean {
  const conflictBlocked = props.conflict && !(props.error?.kind === 'invalid_request' && !props.copyPending);
  const unpreparedReply = props.source?.kind === 'reply' && (!props.activeRef?.draftId || props.creating);
  return props.closing || props.transitioning || props.deletePending || conflictBlocked || props.deleting || unpreparedReply;
}

function describe(error: MailError): string {
  switch (error.kind) {
    case 'draft_conflict': return `Conflict: another save created revision ${error.currentRevision}. Your text is unchanged.`;
    case 'invalid_request': return `Invalid ${error.field}; correct the text and retry.`;
    case 'reply_unavailable': return 'Reply preparation is unavailable: current complete reply headers could not be verified.';
    case 'not_found': return 'That local draft is no longer available.';
    case 'auth_required': return 'No active account. Reconnect the same account to access its local drafts.';
    case 'profile_in_use': return 'The local profile is in use by another window.';
    case 'request_id_conflict': return 'The request ID conflicted; your text remains in the editor.';
    case 'storage_unavailable': return 'Local storage did not confirm the save. Retry is safe.';
    default: return 'The local draft operation was not confirmed. Your text remains in the editor.';
  }
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
      <header class="composer-heading">
        <h2>{{ props.source?.kind === 'reply' ? 'Reply draft' : 'New local draft' }}</h2>
        <div class="composer-actions">
          <button type="button" data-test="close-composer" :disabled="props.closing || props.transitioning || props.deleting || props.deletePending" @click="emit('closeEditor')">Close editor</button>
          <button v-if="props.canCancelReplyPreparation" type="button" data-test="cancel-reply-preparation" :disabled="props.closing || props.transitioning" @click="emit('cancelReplyPreparation')">Cancel reply preparation</button>
          <button type="button" data-test="discard-draft" :disabled="props.closing || props.transitioning || props.deleting || props.deletePending || props.creating || props.conflict || !props.activeRef?.draftId" @click="emit('askDiscard')">Discard…</button>
        </div>
      </header>
      <p class="draft-local-note" role="note">
        Local-only plain text. No Send action exists. Recipient text is stored raw and is not validated or made ready to send.
        Cc is optional; Bcc, reply-all, quoted text, and rich text are not supported.
      </p>
      <p v-if="props.source?.kind === 'reply'" class="reply-source" data-test="reply-source">
        Reply source is fixed: {{ props.source.conversation.conversationId }} · {{ props.source.sourceMessageId }}
      </p>
      <p v-if="props.status" class="draft-status" data-test="draft-status" aria-live="polite">{{ props.status }}</p>
      <p v-if="props.error" role="alert" data-test="draft-error">{{ describe(props.error) }}</p>
      <p v-if="props.createError" role="alert" data-test="draft-create-error">{{ describe(props.createError) }}</p>
      <p v-if="props.closeError" role="alert" data-test="draft-close-error">{{ props.closeError }}</p>
      <div class="composer-fields" :aria-busy="props.saving || props.creating">
        <label>To
          <input data-test="draft-to" type="text" autocomplete="off" :value="props.content.to" :disabled="fieldsDisabled()" @input="emit('setField', 'to', ($event.target as HTMLInputElement).value)">
        </label>
        <label>Cc
          <input data-test="draft-cc" type="text" autocomplete="off" :value="props.content.cc" :disabled="fieldsDisabled()" @input="emit('setField', 'cc', ($event.target as HTMLInputElement).value)">
        </label>
        <label>Subject
          <input data-test="draft-subject" type="text" autocomplete="off" :value="props.content.subject" :disabled="fieldsDisabled()" @input="emit('setField', 'subject', ($event.target as HTMLInputElement).value)">
        </label>
        <label>Body
          <textarea data-test="draft-body" :value="props.content.bodyText" :disabled="fieldsDisabled()" @input="emit('setField', 'bodyText', ($event.target as HTMLTextAreaElement).value)"></textarea>
        </label>
      </div>
      <div class="composer-actions" v-if="props.error || props.createError">
        <button type="button" data-test="retry-draft-save" :disabled="props.closing || props.copyPending || props.transitioning" @click="emit('retry')">
          {{ props.deletePending ? 'Retry discard' : 'Retry save' }}
        </button>
      </div>
      <div v-if="props.conflict || (props.error?.kind === 'not_found' && !!props.activeRef?.draftId)" class="conflict-actions" data-test="draft-conflict-actions">
        <div v-if="props.error?.kind === 'not_found' && !props.conflict" role="alert" data-test="deleted-draft-recovery">
          The saved draft was deleted elsewhere. Your edited buffer is preserved; save it as an independent new message or keep it here.
        </div>
        <div v-if="props.confirmReload && props.conflict" role="alertdialog" aria-label="Confirm reload">
          <p>Reload replaces this exact editor text with the saved version. Continue?</p>
          <button type="button" data-test="confirm-reload" @click="emit('confirmReload')">Replace with saved version</button>
          <button type="button" data-test="cancel-reload" @click="emit('cancelReload')">Keep my text</button>
        </div>
        <button v-if="props.conflict && !props.confirmReload" type="button" data-test="ask-reload" @click="emit('askReload')">Reload saved version…</button>
        <button type="button" data-test="save-as-new" :disabled="props.copyPending || props.transitioning" @click="emit('saveAsNew')">{{ props.copyPending ? 'Copying…' : 'Save as new local draft' }}</button>
      </div>
      <div v-if="props.confirmDiscard" class="discard-confirm" role="alertdialog" aria-label="Confirm discard">
        <p>Discard this local draft? This cannot be undone.</p>
        <button type="button" data-test="confirm-discard" @click="emit('confirmDiscard')">Confirm discard</button>
        <button type="button" data-test="cancel-discard" @click="emit('cancelDiscard')">Keep draft</button>
      </div>
    </section>
  </section>
</template>
