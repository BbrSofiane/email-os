<script setup lang="ts">
/**
 * Local drafts drawer. One column: the list is the default view; opening a
 * draft or "New draft" replaces it with the editor (`DraftEditorCore`,
 * unchanged), and `Back to drafts` returns through the editor's own protected
 * close (`closeEditor`: flush, then hide). A failed flush keeps the editor
 * open with its error, exactly as the editor's footer does.
 *
 * Rows are the shared drawer rows (recipient, subject, updated time). Revision
 * numbers are evidence: they sit in the row title, and show as a word only while
 * that draft is in conflict.
 */
import { computed } from 'vue';
import type { DraftContent, DraftRef, DraftSource, DraftSummary, MailError } from '../lib/ipc/client';
import { describeDraftError } from '../lib/draft-errors';
import { compactDateLabel, fullDateLabel, machineDateTime } from '../lib/browsing-dates';
import { useDrawerRows } from '../composables/useDrawerRows';
import DraftEditorCore from './DraftEditorCore.vue';

const LOCAL_LINE = 'Local to this device · never sent';
const LOCAL_DETAIL = 'Drafts are local to this device and account. No drafts are sent to a mail provider.';

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

function draftKey(ref: DraftRef): string {
  return `${ref.accountId}:${ref.draftId}`;
}

const rows = useDrawerRows({ keys: () => props.summaries.map((draft) => draftKey(draft.ref)) });

/** The revision is shown as a word only while this very draft is in conflict. */
function inConflict(ref: DraftRef): boolean {
  return props.conflict && !!props.activeRef && props.activeRef.accountId === ref.accountId && props.activeRef.draftId === ref.draftId;
}

function rowTitle(draft: DraftSummary): string {
  return `Revision ${draft.revision} · ${draft.source.kind === 'reply' ? 'Reply' : 'New message'}`;
}

/** Back uses the same protected close as the editor's own control. */
const backDisabled = computed(() => props.closing || props.transitioning || props.deleting || props.deletePending);

function onSetField(field: keyof DraftContent, value: string): void {
  emit('setField', field, value);
}
</script>

<template>
  <div class="drafts-pane" data-test="drafts-pane">
    <!-- Recovery and error lines stay visible in both views. -->
    <p v-if="props.suspendedEditor" role="alert" class="drawer-alert" data-test="suspended-editor">
      An editor from another account is suspended in memory. Its text is hidden and will not be saved to this account; return to the original account to resolve it.
    </p>
    <p v-if="props.closeError && !props.visible" role="alert" class="drawer-alert" data-test="draft-close-error">{{ props.closeError }}</p>
    <p v-if="props.closeSetupError" role="alert" class="drawer-alert" data-test="draft-close-setup-error">
      Close protection could not be initialized: {{ props.closeSetupError }}
      <button type="button" class="drawer-quiet" data-test="retry-close-setup" @click="emit('retryCloseSetup')">Retry close protection</button>
    </p>
    <p v-if="props.closeRetryAvailable" class="drawer-line"><button type="button" class="drawer-quiet" data-test="retry-close" @click="emit('retryClose')">Retry close request</button></p>
    <p v-if="props.listError" role="alert" class="drawer-alert" data-test="draft-list-error">Could not load drafts: {{ describe(props.listError) }}</p>
    <p v-if="props.subscriptionError" role="alert" class="drawer-alert" data-test="draft-subscription-error">
      Draft change notifications are unavailable; this list will refresh on reconnect and after local saves. {{ describe(props.subscriptionError) }}
      <button type="button" class="drawer-quiet" data-test="retry-draft-subscription" @click="emit('retryDraftSubscription')">Retry draft updates</button>
    </p>

    <div v-if="!props.visible" class="draft-list" data-test="draft-list-view" @keydown="rows.onKeydown">
      <div class="drawer-toolbar">
        <!-- The one standing local-only line; the sentence is its title and hidden text. -->
        <p class="drawer-note draft-local-note" role="note" :title="LOCAL_DETAIL">{{ LOCAL_LINE }}<span class="visually-hidden">. {{ LOCAL_DETAIL }}</span></p>
        <button type="button" class="drawer-action" data-test="new-draft" :disabled="props.closing || props.transitioning" @click="emit('newDraft')">New draft</button>
      </div>
      <p v-if="props.createError" role="alert" class="drawer-alert" data-test="draft-open-error">{{ describe(props.createError) }}</p>
      <p v-else-if="props.summaries.length === 0" class="drawer-note" data-test="draft-list-empty">No local drafts.</p>
      <ul v-else class="drawer-rows" data-test="draft-list">
        <li v-for="draft in props.summaries" :key="draftKey(draft.ref)">
          <div class="drawer-row">
            <button
              type="button"
              class="drawer-row-main draft-row"
              v-bind="rows.rowAttrs(draftKey(draft.ref))"
              :data-test="`open-draft-${draft.ref.draftId}`"
              :title="rowTitle(draft)"
              :disabled="props.closing || props.transitioning"
              @click="emit('openDraft', draft.ref)"
            >
              <span class="drawer-sender" :class="{ 'drawer-empty': !draft.to }">{{ draft.to || '(no recipient)' }}</span>
              <span class="drawer-subject" :class="{ 'drawer-empty': !draft.subject }">{{ draft.subject || '(no subject)' }}</span>
              <span v-if="inConflict(draft.ref)" class="drawer-flag tone-warn" data-test="draft-row-conflict">Conflict · revision {{ draft.revision }}</span>
              <span v-if="draft.source.kind === 'reply'" class="drawer-flag">Reply</span>
              <time class="drawer-date row-time" :datetime="machineDateTime(draft.updatedAt)" :title="fullDateLabel(draft.updatedAt)">{{ compactDateLabel(draft.updatedAt) }}</time>
            </button>
          </div>
        </li>
      </ul>
    </div>

    <div v-else class="composer" data-test="composer">
      <p class="drawer-line">
        <button type="button" class="drawer-quiet" data-test="back-to-drafts" :disabled="backDisabled" @click="emit('closeEditor')">Back to drafts</button>
      </p>
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
          <!-- A sub-section of the drawer: the drawer owns the one h2. -->
          <header class="composer-heading">
            <h3 v-if="props.source?.kind === 'reply' && props.recipientLabel">Reply draft <span class="reply-to">to <span data-test="draft-recipient-label">{{ props.recipientLabel }}</span></span></h3>
            <h3 v-else-if="props.source?.kind === 'reply'">Reply draft</h3>
            <h3 v-else>New local draft</h3>
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
        </template>
      </DraftEditorCore>
    </div>
  </div>
</template>
