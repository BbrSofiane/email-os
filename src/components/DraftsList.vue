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
 * `(no subject)`) followed by a quiet one-line body preview (Ash; `No text
 * yet` for an empty body; nothing while the body is unknown), a quiet
 * `Discard` row action, a quiet `Reply` word for reply drafts and the compact
 * updated time. The revision is a row title, and a word (`Conflict · revision
 * N`, Amber Notice) only while that draft is the one in conflict.
 *
 * The summary carries no body, so the preview reads each body once through
 * `loadBody` (see `useDraftPreviews`). It is plain literal text in a text node.
 *
 * `Discard` asks first, in a confirmation line under its row with the editor's
 * wording. Only `discardDraft` (the app's delete) removes a draft; a failure
 * keeps the draft and says so, a success moves focus to the next row (else the
 * previous one, else the pane) and announces `Local draft deleted`. A draft
 * that is open in the editor cannot be discarded here.
 *
 * The app's key handler reaches the focused row through `discardRow` (Delete
 * or Backspace). It only opens the same confirmation as the button and never
 * discards; a row that cannot be discarded (editor open, busy, no `discardDraft`)
 * answers `false` and nothing happens.
 */
import { computed, nextTick, ref } from 'vue';
import type { DraftRef, DraftSummary, MailError } from '../lib/ipc/client';
import { compactDateLabel, fullDateLabel, machineDateTime } from '../lib/browsing-dates';
import { describeDiscardError, isDefiniteDiscardFailure } from '../lib/draft-errors';
import { useDraftPreviews } from '../composables/useDraftPreviews';
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
  /** Reads one draft's body for its preview; without it rows show no preview. */
  loadBody?: (ref: DraftRef) => Promise<string>;
  /** Deletes one draft after the list's confirmation; resolves to null once confirmed, else the error. Without it rows offer no Discard. */
  discardDraft?: (draft: DraftSummary, requestId: string) => Promise<MailError | null>;
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

function rowLabel(draft: DraftSummary): string {
  return draft.to || draft.subject || 'with no recipient or subject';
}

const { previewFor } = useDraftPreviews(
  () => props.summaries,
  (ref) => props.loadBody ? props.loadBody(ref) : Promise.reject(new Error('no body loader')),
);

const list = ref<{ focusRow: (key: string | null, options?: { preventScroll?: boolean }) => Promise<void> } | null>(null);
const paneEl = ref<HTMLElement | null>(null);

// Discard from the list: one confirmation at a time, under its row.
const confirmKey = ref<string | null>(null);
const discarding = ref(false);
const discardError = ref<MailError | null>(null);
const discardStatus = ref('');
/** One request id per confirmation, kept across retries so a lost acknowledgement is repeated, not doubled. */
let requestId: string | null = null;

function newRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The editor owns this draft while it is open there, so the list must not delete it. */
function editorOwns(ref: DraftRef): boolean {
  return !!props.activeRef && props.activeRef.accountId === ref.accountId && props.activeRef.draftId === ref.draftId;
}
function discardDisabled(item: DraftItem): boolean {
  return props.busy || discarding.value || editorOwns(item.draft.ref);
}

function rowEl(item: DraftItem, selector: string): HTMLElement | null {
  return paneEl.value?.querySelector<HTMLElement>(`[data-test="draft-row-${item.draft.ref.draftId}"] ${selector}`) ?? null;
}

async function askDiscard(item: DraftItem): Promise<void> {
  if (!props.discardDraft || discardDisabled(item)) return;
  confirmKey.value = item.key;
  requestId = newRequestId();
  discardError.value = null;
  discardStatus.value = '';
  await nextTick();
  rowEl(item, '[data-test="confirm-discard-draft"]')?.focus();
}

/** Open the confirmation for the row with this key, like its button. False when the row offers no Discard. */
function discardRow(key: string): boolean {
  const item = items.value.find(candidate => candidate.key === key);
  if (!item || !props.discardDraft || discardDisabled(item)) return false;
  void askDiscard(item);
  return true;
}

async function cancelDiscard(item: DraftItem): Promise<void> {
  if (discarding.value) return;
  confirmKey.value = null;
  requestId = null;
  await nextTick();
  rowEl(item, '[data-test="discard-draft"]')?.focus();
}

function onConfirmKeydown(event: KeyboardEvent, item: DraftItem): void {
  if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
  // The confirmation owns this Escape: it must not also run the app's Back.
  event.stopPropagation(); event.preventDefault();
  void cancelDiscard(item);
}

async function confirmDiscard(item: DraftItem): Promise<void> {
  const send = props.discardDraft;
  if (!send || confirmKey.value !== item.key || discarding.value || editorOwns(item.draft.ref)) return;
  const index = items.value.findIndex((candidate) => candidate.key === item.key);
  const neighbour = items.value[index + 1]?.key ?? items.value[index - 1]?.key ?? null;
  discarding.value = true;
  discardError.value = null;
  discardStatus.value = 'Discarding draft…';
  const error = await send(item.draft, requestId ?? newRequestId());
  discarding.value = false;
  if (!error) {
    confirmKey.value = null;
    requestId = null;
    discardStatus.value = 'Local draft deleted';
    await nextTick();
    if (neighbour !== null && items.value.some((candidate) => candidate.key === neighbour)) emit('update:activeKey', neighbour);
    // `focusRow` falls back to the first row, then to the pane when no row is left.
    if (list.value) await list.value.focusRow(neighbour, {});
    else paneEl.value?.focus();
    return;
  }
  // The draft stays in the list, and the failure stays visible until the next attempt.
  discardStatus.value = '';
  discardError.value = error;
  if (isDefiniteDiscardFailure(error)) {
    confirmKey.value = null;
    requestId = null;
    await nextTick();
    rowEl(item, '[data-test="discard-draft"]')?.focus();
  }
}

/** Focus the current row, or the pane itself when there is no row to take it. */
async function focusRow(options: { preventScroll?: boolean } = {}): Promise<void> {
  if (list.value) await list.value.focusRow(props.activeKey, options);
  else paneEl.value?.focus(options);
}
defineExpose({ focusRow, discardRow, el: paneEl });
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

    <!-- Discard outcome: the live region stays mounted (zero height when empty) so each result is announced. -->
    <p class="draft-discard-status" role="status" aria-live="polite" data-test="draft-discard-status">{{ discardStatus }}</p>
    <div v-if="discardError" class="draft-notices">
      <p role="alert" class="drawer-alert" data-test="draft-discard-error">{{ describeDiscardError(discardError) }}</p>
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
      :row-test-id="(item: DraftItem) => `draft-row-${item.draft.ref.draftId}`"
      :open-test-id="(item: DraftItem) => `open-draft-${item.draft.ref.draftId}`"
      @update:active-key="emit('update:activeKey', $event)"
      @open="emit('open', $event.draft)"
    >
      <template #primary="{ item }"><span class="context-subject" :class="{ 'drawer-empty': !item.draft.to }">{{ item.draft.to || '(no recipient)' }}</span></template>
      <template #secondary="{ item }">
        <span class="draft-subject" :class="{ 'drawer-empty': !item.draft.subject }">{{ item.draft.subject || '(no subject)' }}</span>
        <!-- Plain text node only: a body that looks like HTML stays literal. Nothing while the body is unknown. -->
        <span v-if="previewFor(item.draft) !== null" class="draft-preview" :class="{ 'drawer-empty': !previewFor(item.draft) }" data-test="draft-preview">{{ previewFor(item.draft) || 'No text yet' }}</span>
      </template>
      <template #actions="{ item }">
        <button
          v-if="discardDraft"
          type="button"
          class="drawer-quiet"
          data-test="discard-draft"
          :aria-label="`Discard draft ${rowLabel(item.draft)}`"
          :title="editorOwns(item.draft.ref) ? 'This draft is open in an editor' : 'Discard this local draft — Delete'"
          aria-keyshortcuts="Delete Backspace"
          :aria-expanded="confirmKey === item.key"
          :disabled="discardDisabled(item)"
          @click="askDiscard(item)"
        >Discard</button>
      </template>
      <template #trailing="{ item }">
        <span v-if="inConflict(item.draft.ref)" class="activity-status tone-warn" data-test="draft-row-conflict">Conflict · revision {{ item.draft.revision }}</span>
        <span v-if="item.draft.source.kind === 'reply'" class="draft-reply">Reply</span>
        <time class="draft-date row-time" :datetime="machineDateTime(item.draft.updatedAt)" :title="fullDateLabel(item.draft.updatedAt)">{{ compactDateLabel(item.draft.updatedAt) }}</time>
      </template>
      <template #note="{ item }">
        <div
          v-if="confirmKey === item.key"
          class="context-row-note draft-discard-confirm"
          role="alertdialog"
          aria-label="Confirm discard"
          :aria-describedby="`discard-prompt-${item.draft.ref.draftId}`"
          data-test="draft-discard-confirm"
          @keydown="onConfirmKeydown($event, item)"
        >
          <span :id="`discard-prompt-${item.draft.ref.draftId}`">Discard this local draft? This cannot be undone.</span>
          <button type="button" class="drawer-quiet" data-test="confirm-discard-draft" :disabled="discarding || editorOwns(item.draft.ref)" @click="confirmDiscard(item)">Confirm discard</button>
          <button type="button" class="drawer-quiet" data-test="cancel-discard-draft" :disabled="discarding" @click="cancelDiscard(item)">Keep draft</button>
        </div>
      </template>
    </ContextRowList>
  </div>
</template>
