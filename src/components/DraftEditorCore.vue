<script setup lang="ts">
/**
 * Shared draft-editor body used by every compose surface (the drafts-drawer
 * editor in DraftsPanel, the inline ComposeCard, and the docked ReplyComposer).
 * One copy of the field markup, the error wording and the disabled-logic — the
 * surfaces differ only in their header and context (recipient label, quoted
 * message) supplied through slots.
 *
 * Frozen draft contract (docs/vertical-slice-04.md): local-only plain text, no
 * Send action/shortcut/IPC, recipient text stored raw and unvalidated, reply
 * body starts blank (quoted context is display-only). All text is bound as
 * plain text; no v-html. The footer offers "Close editor" and "Discard…" only.
 */
import { nextTick, ref, watch } from 'vue';
import type { DraftContent, DraftRef, DraftSource, MailError } from '../lib/ipc/client';
import { describeDraftError } from '../lib/draft-errors';

const props = defineProps<{
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
  /** Which field receives focus when the editor appears (keyboard-first). */
  autofocus?: 'to' | 'body';
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

/** Single shared copy — do not fork per surface. */
function fieldsDisabled(): boolean {
  const conflictBlocked = props.conflict && !(props.error?.kind === 'invalid_request' && !props.copyPending);
  const unpreparedReply = props.source?.kind === 'reply' && (!props.activeRef?.draftId || props.creating);
  return props.closing || props.transitioning || props.deletePending || conflictBlocked || props.deleting || unpreparedReply;
}

function describe(error: MailError): string {
  return describeDraftError(error);
}

const toInput = ref<HTMLInputElement | null>(null);
const bodyInput = ref<HTMLTextAreaElement | null>(null);
const dialog = ref<HTMLElement | null>(null);

watch(() => props.autofocus, async (field) => {
  await nextTick();
  if (field === 'to') toInput.value?.focus();
  else if (field === 'body') bodyInput.value?.focus();
}, { immediate: true });

// Move focus into a confirm dialog when it appears, and describe it, so the
// prompt is announced instead of silently appearing.
watch(() => props.confirmDiscard || props.confirmReload, async (open) => {
  if (!open) return;
  await nextTick();
  (dialog.value?.querySelector('button') as HTMLButtonElement | null)?.focus();
});
</script>

<template>
  <div class="composer-body">
    <slot name="header" />
    <p class="draft-local-note" role="note">
      Local-only plain text. No Send action exists. Recipient text is stored raw and is not validated or made ready to send.
      Cc is optional; Bcc, reply-all, quoted text, and rich text are not supported.
    </p>
    <slot name="context" />
    <p v-if="props.status" class="draft-status" data-test="draft-status" aria-live="polite">{{ props.status }}</p>
    <p v-if="props.error" role="alert" data-test="draft-error">{{ describe(props.error) }}</p>
    <p v-if="props.createError" role="alert" data-test="draft-create-error">{{ describe(props.createError) }}</p>
    <p v-if="props.closeError" role="alert" data-test="draft-close-error">{{ props.closeError }}</p>
    <div class="composer-fields" :aria-busy="props.saving || props.creating">
      <label>To
        <input ref="toInput" data-test="draft-to" type="text" autocomplete="off" :value="props.content.to" :disabled="fieldsDisabled()" @input="emit('setField', 'to', ($event.target as HTMLInputElement).value)">
      </label>
      <label>Cc
        <input data-test="draft-cc" type="text" autocomplete="off" :value="props.content.cc" :disabled="fieldsDisabled()" @input="emit('setField', 'cc', ($event.target as HTMLInputElement).value)">
      </label>
      <label>Subject
        <input data-test="draft-subject" type="text" autocomplete="off" :value="props.content.subject" :disabled="fieldsDisabled()" @input="emit('setField', 'subject', ($event.target as HTMLInputElement).value)">
      </label>
      <label>Body
        <textarea ref="bodyInput" data-test="draft-body" :value="props.content.bodyText" :disabled="fieldsDisabled()" @input="emit('setField', 'bodyText', ($event.target as HTMLTextAreaElement).value)"></textarea>
      </label>
    </div>
    <div class="composer-actions" v-if="(props.error || props.createError) && !props.recoveryRequired">
      <button type="button" data-test="retry-draft-save" :disabled="props.closing || props.copyPending || props.transitioning" @click="emit('retry')">
        {{ props.deletePending ? 'Retry discard' : 'Retry save' }}
      </button>
    </div>
    <div v-if="props.conflict || props.recoveryRequired || (props.error?.kind === 'not_found' && !!props.activeRef?.draftId)" class="conflict-actions" data-test="draft-conflict-actions">
      <div v-if="props.recoveryRequired || (props.error?.kind === 'not_found' && !props.conflict)" role="alert" data-test="deleted-draft-recovery">
        The saved draft or recovery copy was deleted elsewhere. Your exact buffer is preserved; save it as an independent new message or keep it here.
      </div>
      <div v-if="props.confirmReload && props.conflict" ref="dialog" role="alertdialog" aria-label="Confirm reload" aria-describedby="reload-prompt">
        <p id="reload-prompt">Reload replaces this exact editor text with the saved version. Continue?</p>
        <button type="button" data-test="confirm-reload" @click="emit('confirmReload')">Replace with saved version</button>
        <button type="button" data-test="cancel-reload" @click="emit('cancelReload')">Keep my text</button>
      </div>
      <button v-if="props.conflict && !props.confirmReload" type="button" data-test="ask-reload" @click="emit('askReload')">Reload saved version…</button>
      <button type="button" data-test="save-as-new" :disabled="props.copyPending || props.transitioning" @click="emit('saveAsNew')">{{ props.copyPending ? 'Copying…' : 'Save as new local draft' }}</button>
    </div>
    <div v-if="props.confirmDiscard" ref="dialog" class="discard-confirm" role="alertdialog" aria-label="Confirm discard" aria-describedby="discard-prompt">
      <p id="discard-prompt">Discard this local draft? This cannot be undone.</p>
      <button type="button" data-test="confirm-discard" :disabled="props.discardBusy || props.deleting || props.deletePending" @click="emit('confirmDiscard')">Confirm discard</button>
      <button type="button" data-test="cancel-discard" :disabled="props.deleting || props.deletePending" @click="emit('cancelDiscard')">Keep draft</button>
    </div>
    <footer class="composer-footer">
      <button type="button" data-test="close-composer" :disabled="props.closing || props.transitioning || props.deleting || props.deletePending" @click="emit('closeEditor')">Close editor</button>
      <button v-if="props.canCancelReplyPreparation" type="button" data-test="cancel-reply-preparation" :disabled="props.closing || props.transitioning" @click="emit('cancelReplyPreparation')">Cancel reply preparation</button>
      <button type="button" data-test="discard-draft" :disabled="props.closing || props.transitioning || props.discardBusy || props.deleting || props.deletePending || props.creating || props.conflict || !props.activeRef?.draftId" @click="emit('askDiscard')">Discard…</button>
    </footer>
  </div>
</template>
