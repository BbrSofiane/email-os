<script setup lang="ts">
/**
 * The Drafts list context: one Ash coverage line with a quiet `New draft`
 * action, the in-flow recovery and error lines, and one row per local draft.
 * Rows are not threads, so they use `ContextRowList` (the 36px list-row
 * anatomy and its keyboard model: J/K, arrows, Home, End, roving tabindex).
 *
 * Opening a draft is the app's decision (`open`): a reply draft goes to its
 * source conversation, a new message to the inline compose card. This
 * component only lists drafts and reports which one was chosen. The editor
 * itself is never mounted here (`DraftEditorCore` lives in the card and the
 * docked reply composer), so the list shows only while no editor covers it.
 *
 * Rows are recipient (Title; Ash `(no recipient)`), subject (Ash
 * `(no subject)`), a quiet `Reply` word for reply drafts and the compact
 * updated time. The revision is a row title, and a word (`Conflict · revision
 * N`, Amber Notice) only while that draft is the one in conflict.
 */
import { computed, ref } from 'vue';
import type { DraftRef, DraftSummary, MailError } from '../lib/ipc/client';
import { compactDateLabel, fullDateLabel, machineDateTime } from '../lib/browsing-dates';
import ContextRowList from './ContextRowList.vue';
import DraftAlerts from './DraftAlerts.vue';

const LOCAL_LINE = 'Local to this device · never sent';
const LOCAL_DETAIL = 'Drafts are local to this device and account. No drafts are sent to a mail provider.';

interface DraftItem { key: string; draft: DraftSummary }

const props = defineProps<{
  summaries: readonly DraftSummary[];
  /** The remembered current row (restored after a reader or editor round trip). */
  activeKey: string | null;
  /** The editor's draft, to mark the one in conflict. */
  activeRef: DraftRef | null;
  conflict: boolean;
  suspendedEditor: boolean;
  /** Opening or creating is disabled while the editor is closing or switching. */
  busy: boolean;
  createError: MailError | null;
  listError: MailError | null;
  subscriptionError: MailError | null;
  closeError: string | null;
  closeRetryAvailable: boolean;
  closeSetupError: string | null;
}>();

const emit = defineEmits<{
  newDraft: [];
  open: [draft: DraftSummary];
  'update:activeKey': [key: string];
  retryDraftSubscription: [];
  retryClose: [];
  retryCloseSetup: [];
}>();

/** Stable row key for one draft; the app uses it to remember the current row. */
function draftKey(ref: DraftRef): string {
  return `${ref.accountId}:${ref.draftId}`;
}

const items = computed<DraftItem[]>(() => props.summaries.map(draft => ({ key: draftKey(draft.ref), draft })));

/** The revision is shown as a word only while this very draft is in conflict. */
function inConflict(ref: DraftRef): boolean {
  return props.conflict && !!props.activeRef && props.activeRef.accountId === ref.accountId && props.activeRef.draftId === ref.draftId;
}

function rowTitle(item: DraftItem): string {
  return `Revision ${item.draft.revision} · ${item.draft.source.kind === 'reply' ? 'Reply' : 'New message'}`;
}

const list = ref<{ focusRow: (key: string | null, options?: { preventScroll?: boolean }) => Promise<void> } | null>(null);
const paneEl = ref<HTMLElement | null>(null);

/** Focus the current row, or the pane itself when there is no row to take it. */
async function focusRow(options: { preventScroll?: boolean } = {}): Promise<void> {
  if (list.value) await list.value.focusRow(props.activeKey, options);
  else paneEl.value?.focus(options);
}
defineExpose({ focusRow, el: paneEl });
</script>

<template>
  <div ref="paneEl" class="context-pane drafts-pane" data-test="drafts-pane" tabindex="-1">
    <!-- Recovery and error lines are in flow above the rows, never hidden. -->
    <DraftAlerts
      :suspended-editor="suspendedEditor"
      :close-error="closeError"
      :close-setup-error="closeSetupError"
      :close-retry-available="closeRetryAvailable"
      :list-error="listError"
      :subscription-error="subscriptionError"
      :create-error="createError"
      @retry-draft-subscription="emit('retryDraftSubscription')"
      @retry-close="emit('retryClose')"
      @retry-close-setup="emit('retryCloseSetup')"
    />

    <!-- The one standing local-only line; the sentence is its title and hidden text. -->
    <div class="context-coverage">
      <p class="cached-coverage" role="note" data-test="drafts-coverage" :title="LOCAL_DETAIL">{{ LOCAL_LINE }}<span class="visually-hidden">. {{ LOCAL_DETAIL }}</span></p>
      <button type="button" class="drawer-quiet" data-test="new-draft" :disabled="busy" @click="emit('newDraft')">New draft</button>
    </div>

    <p v-if="!items.length" class="list-state" data-test="draft-list-empty">No local drafts.</p>
    <ContextRowList
      v-else
      ref="list"
      data-test="draft-list"
      :items="items"
      label="Local drafts"
      :active-key="activeKey"
      :disabled="busy"
      :row-title="rowTitle"
      :open-test-id="(item: DraftItem) => `open-draft-${item.draft.ref.draftId}`"
      @update:active-key="emit('update:activeKey', $event)"
      @open="emit('open', $event.draft)"
    >
      <template #primary="{ item }"><span class="context-subject" :class="{ 'drawer-empty': !item.draft.to }">{{ item.draft.to || '(no recipient)' }}</span></template>
      <template #secondary="{ item }"><span class="draft-subject" :class="{ 'drawer-empty': !item.draft.subject }">{{ item.draft.subject || '(no subject)' }}</span></template>
      <template #trailing="{ item }">
        <span v-if="inConflict(item.draft.ref)" class="activity-status tone-warn" data-test="draft-row-conflict">Conflict · revision {{ item.draft.revision }}</span>
        <span v-if="item.draft.source.kind === 'reply'" class="draft-reply">Reply</span>
        <time class="draft-date row-time" :datetime="machineDateTime(item.draft.updatedAt)" :title="fullDateLabel(item.draft.updatedAt)">{{ compactDateLabel(item.draft.updatedAt) }}</time>
      </template>
    </ContextRowList>
  </div>
</template>
