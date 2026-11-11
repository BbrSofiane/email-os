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
 * wording. The draft, revision and request id are frozen when the confirmation
 * opens: a row that refreshes to a newer revision meanwhile is not deleted
 * under a confirmation shown for the old one (the revision check rejects it).
 * Only `discardDraft` (the app's delete) removes a draft; a failure keeps the
 * draft and says so, a success moves focus to the next row (else the previous
 * one, else the pane) and announces `Local draft deleted` in a visually hidden
 * live region. A draft that is open in the editor cannot be discarded here.
 * While a request runs the confirmation buttons stay focusable
 * (`aria-disabled`, not `disabled`), and focus is restored after every result,
 * so Escape still closes the confirmation instead of going Back.
 *
 * Each row button is described by its subject, preview and status words
 * (`aria-describedby`), so a screen reader hears more than the address.
 *
 * The app's key handler reaches the focused row through `discardRow` (Delete
 * or Backspace). It only opens the same confirmation as the button and never
 * discards; a row that cannot be discarded (editor open, busy, no `discardDraft`)
 * answers `false` and nothing happens.
 */
import { computed, nextTick, ref, useId, watchPostEffect } from 'vue';
import type { DraftRef, DraftSummary, MailError } from '../lib/ipc/client';
import { compactDateLabel, fullDateLabel, machineDateTime } from '../lib/browsing-dates';
import { describeDiscardError, isDefiniteDiscardFailure, type DiscardBusyReason } from '../lib/draft-errors';
import { useDraftPreviews } from '../composables/useDraftPreviews';
import ContextRowList from './ContextRowList.vue';
import DraftAlerts from './DraftAlerts.vue';
import type { DraftAlertProps } from './draft-alert-props';

const LOCAL_LINE = 'Local to this device · never sent';
const LOCAL_DETAIL = 'Drafts are local to this device and account. No drafts are sent to a mail provider.';

interface DraftItem { key: string; draft: DraftSummary }

const props = defineProps<DraftAlertProps & {
  summaries: readonly DraftSummary[];
  /** The remembered current row (restored after a reader or editor round trip). */
  activeKey: string | null;
  /** The editor's draft, to mark the one in conflict. */
  activeRef: DraftRef | null;
  conflict: boolean;
  /** Opening or creating is disabled while the editor is closing or switching. */
  busy: boolean;
  /** The window is closing; only used to word a refused Discard. */
  closingForWindow?: boolean;
  /** Drafts whose open is pending (`getDraft` in flight): they cannot be discarded meanwhile. */
  openingRefs?: readonly DraftRef[];
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

const uid = useId();
type DescriptionPart = 'subject' | 'preview' | 'conflict' | 'reply';
function descId(item: DraftItem, part: DescriptionPart): string {
  return `${uid}-${item.draft.ref.draftId}-${part}`;
}
/** The ids of the row's description slots that are on screen now, in reading order. */
function describedBy(item: DraftItem): string {
  const parts: DescriptionPart[] = ['subject'];
  if (previewFor(item.draft) !== null) parts.push('preview');
  if (inConflict(item.draft.ref)) parts.push('conflict');
  if (item.draft.source.kind === 'reply') parts.push('reply');
  return parts.map((part) => descId(item, part)).join(' ');
}

const list = ref<{ focusRow: (key: string | null, options?: { preventScroll?: boolean }) => Promise<void> } | null>(null);
const paneEl = ref<HTMLElement | null>(null);

// `ContextRowList` owns the row button and has no description slot, so the
// description is set on the button after each render.
watchPostEffect(() => {
  for (const item of items.value) {
    const button = paneEl.value?.querySelector(`[data-test="open-draft-${item.draft.ref.draftId}"]`);
    button?.setAttribute('aria-describedby', describedBy(item));
    // Stays focusable: a row being deleted is not opened, but focus must not fall off it.
    if (openLocked(item)) button?.setAttribute('aria-disabled', 'true'); else button?.removeAttribute('aria-disabled');
  }
});

// Discard from the list: one confirmation at a time, under its row.
const confirmKey = ref<string | null>(null);
const discarding = ref(false);
/** The row whose delete is running: it cannot be opened meanwhile. */
const discardingKey = ref<string | null>(null);
const discardBusyReason = ref<DiscardBusyReason>('editor');
const discardError = ref<MailError | null>(null);
const discardStatus = ref('');
/**
 * What the open confirmation is about, frozen when it opened: the draft with
 * its revision, and one request id kept across retries so a lost
 * acknowledgement is repeated, not doubled. A newer row revision never replaces it.
 */
let pending: { key: string; draft: DraftSummary; requestId: string } | null = null;

function newRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The editor owns this draft while it is open there, so the list must not delete it. */
function editorOwns(ref: DraftRef): boolean {
  return !!props.activeRef && props.activeRef.accountId === ref.accountId && props.activeRef.draftId === ref.draftId;
}
/** The draft is being opened (its `getDraft` is pending), so the list must not delete it. */
function openPending(ref: DraftRef): boolean {
  return !!props.openingRefs?.some((opening) => opening.accountId === ref.accountId && opening.draftId === ref.draftId);
}
function discardDisabled(item: DraftItem): boolean {
  return props.busy || discarding.value || editorOwns(item.draft.ref) || openPending(item.draft.ref);
}
/** A row whose delete is running is not opened. */
function openLocked(item: DraftItem): boolean {
  return discardingKey.value === item.key;
}
/** Why a refused Discard was refused, read when the failure arrives. */
function busyReason(ref: DraftRef): DiscardBusyReason {
  if (editorOwns(ref)) return 'editor';
  if (openPending(ref)) return 'opening';
  return props.closingForWindow ? 'closing_window' : props.busy ? 'switching' : 'editor';
}
function onOpen(item: DraftItem): void {
  if (!openLocked(item)) emit('open', item.draft);
}

function rowEl(item: DraftItem, selector: string): HTMLElement | null {
  return paneEl.value?.querySelector<HTMLElement>(`[data-test="draft-row-${item.draft.ref.draftId}"] ${selector}`) ?? null;
}

async function askDiscard(item: DraftItem): Promise<void> {
  if (!props.discardDraft || discardDisabled(item)) return;
  confirmKey.value = item.key;
  pending = { key: item.key, draft: { ...item.draft, ref: { ...item.draft.ref } }, requestId: newRequestId() };
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
  pending = null;
  await nextTick();
  rowEl(item, '[data-test="discard-draft"]')?.focus();
}

function onConfirmKeydown(event: KeyboardEvent, item: DraftItem): void {
  if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
  // The confirmation owns this Escape: it must not also run the app's Back.
  event.stopPropagation(); event.preventDefault();
  void cancelDiscard(item);
}

/**
 * Put focus back on `target` only when the request left it nowhere (body or none) or still in the
 * confirmation it started in. Focus the user moved to any other control stays there.
 */
function refocus(target: HTMLElement | null, confirmation: HTMLElement | null): void {
  const active = document.activeElement;
  if (active && active !== document.body && !confirmation?.contains(active)) return;
  target?.focus();
}

async function confirmDiscard(item: DraftItem): Promise<void> {
  const send = props.discardDraft;
  const frozen = pending;
  if (!send || !frozen || frozen.key !== item.key || confirmKey.value !== item.key || discarding.value || editorOwns(frozen.draft.ref)) return;
  const index = items.value.findIndex((candidate) => candidate.key === item.key);
  const neighbour = items.value[index + 1]?.key ?? items.value[index - 1]?.key ?? null;
  const confirmation = rowEl(item, '[data-test="draft-discard-confirm"]');
  discarding.value = true;
  discardingKey.value = item.key;
  discardError.value = null;
  discardStatus.value = 'Discarding draft…';
  const error = await send(frozen.draft, frozen.requestId);
  discarding.value = false;
  discardingKey.value = null;
  if (!error) {
    confirmKey.value = null;
    pending = null;
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
  discardBusyReason.value = busyReason(frozen.draft.ref);
  const definite = isDefiniteDiscardFailure(error);
  if (definite) {
    confirmKey.value = null;
    pending = null;
  }
  await nextTick();
  // Definite: back to this row's Discard. Retryable: the confirmation stays, so focus stays in it and Escape closes it.
  refocus(rowEl(item, definite ? '[data-test="discard-draft"]' : '[data-test="confirm-discard-draft"]'), confirmation);
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

    <!-- Discard outcome: the live region stays mounted and visually hidden so each result is announced. -->
    <p class="draft-discard-status visually-hidden" role="status" aria-live="polite" data-test="draft-discard-status">{{ discardStatus }}</p>
    <div v-if="discardError" class="draft-notices">
      <p role="alert" class="drawer-alert" data-test="draft-discard-error">{{ describeDiscardError(discardError, discardBusyReason) }}</p>
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
      @open="onOpen($event)"
    >
      <template #primary="{ item }"><span class="context-subject" :class="{ 'drawer-empty': !item.draft.to }">{{ item.draft.to || '(no recipient)' }}</span></template>
      <template #secondary="{ item }">
        <span :id="descId(item, 'subject')" class="draft-subject" :class="{ 'drawer-empty': !item.draft.subject }">{{ item.draft.subject || '(no subject)' }}</span>
        <!-- Plain text node only: a body that looks like HTML stays literal. Nothing while the body is unknown. -->
        <span v-if="previewFor(item.draft) !== null" :id="descId(item, 'preview')" class="draft-preview" :class="{ 'drawer-empty': !previewFor(item.draft) }" data-test="draft-preview">{{ previewFor(item.draft) || 'No text yet' }}</span>
      </template>
      <template #actions="{ item }">
        <button
          v-if="discardDraft"
          type="button"
          class="drawer-quiet"
          data-test="discard-draft"
          :aria-label="`Discard draft ${rowLabel(item.draft)}`"
          :title="editorOwns(item.draft.ref) ? 'This draft is open in an editor' : openPending(item.draft.ref) ? 'This draft is being opened' : 'Discard this local draft — Delete or Backspace'"
          aria-keyshortcuts="Delete Backspace"
          :aria-expanded="confirmKey === item.key"
          :disabled="discardDisabled(item)"
          @click="askDiscard(item)"
        >Discard</button>
      </template>
      <template #trailing="{ item }">
        <span v-if="inConflict(item.draft.ref)" :id="descId(item, 'conflict')" class="activity-status tone-warn" data-test="draft-row-conflict">Conflict · revision {{ item.draft.revision }}</span>
        <span v-if="item.draft.source.kind === 'reply'" :id="descId(item, 'reply')" class="draft-reply">Reply</span>
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
          <button type="button" class="drawer-quiet" data-test="confirm-discard-draft" :aria-disabled="discarding || editorOwns(item.draft.ref) ? 'true' : undefined" @click="confirmDiscard(item)">Confirm discard</button>
          <button type="button" class="drawer-quiet" data-test="cancel-discard-draft" :aria-disabled="discarding ? 'true' : undefined" @click="cancelDiscard(item)">Keep draft</button>
        </div>
      </template>
    </ContextRowList>
  </div>
</template>
