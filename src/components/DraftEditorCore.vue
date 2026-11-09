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
 * plain text; no v-html. The footer offers "Save and close" and "Discard…"
 * only (plus "Cancel reply preparation" while one is pending).
 *
 * Layouts: `variant="new"` shows To and Subject as one-line rows with Cc on
 * demand; `variant="reply"` is the compact docked reply: a one-line recipient
 * row, Cc and Subject on demand, and the body as the dominant field. Both use
 * the same inputs, hooks and disabled-logic.
 */
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
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
  /** `reply` is the compact docked layout; `new` keeps To and Subject visible. */
  variant?: 'new' | 'reply';
  /** Reply only: the display name shown while To is still the default mailbox. */
  recipientLabel?: string | null;
  /** Reply only: the default To (the latest message sender's mailbox). */
  recipientMailbox?: string | null;
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
  return props.closing || props.transitioning || props.deletePending || conflictBlocked || props.deleting || unpreparedReply.value;
}

function describe(error: MailError): string {
  return describeDraftError(error);
}

const toInput = ref<HTMLInputElement | null>(null);
const ccInput = ref<HTMLInputElement | null>(null);
const bodyInput = ref<HTMLTextAreaElement | null>(null);
const dialog = ref<HTMLElement | null>(null);

const uid = useId();
const ids = { to: `${uid}-to`, cc: `${uid}-cc`, subject: `${uid}-subject`, body: `${uid}-body`, detail: `${uid}-detail`, extras: `${uid}-extras`, caveat: `${uid}-caveat` };

const isReply = computed(() => props.variant === 'reply');

// ---- One status line ------------------------------------------------------

/** Plain-language detail for the title and the body's hidden description. */
const LOCAL_DETAIL = 'Local plain-text draft. Nothing is sent. Recipients are stored as typed and are not validated. Bcc, reply-all and rich text are not supported.';
/** Settled states that read "<state> · not sent"; the first two stay calm (Ash). */
const SETTLED_CALM = new Set(['Saved locally', 'Draft loaded from this device']);
const SETTLED_NON_DURABLE = new Set(['Saved in preview memory (non-durable)', 'Loaded from preview memory (non-durable)']);

const statusLine = computed(() => {
  const status = props.status;
  if (!status) return { text: 'Local draft · not sent', calm: true };
  if (SETTLED_CALM.has(status)) return { text: `${status} · not sent`, calm: true };
  if (SETTLED_NON_DURABLE.has(status)) return { text: `${status} · not sent`, calm: false };
  // Saving, creating, unconfirmed and conflict states keep their own words, in Amber Notice.
  return { text: status, calm: false };
});

/** The caveats are one extra line behind a real button (keyboard and touch), never tooltip-only. */
const caveatOpen = ref(false);

/**
 * Quiet live region. The visible status flips Saving…/Saved on every autosave,
 * which would be chatty if announced; only the first settled state, a problem
 * (not confirmed, conflict) and the recovery from a problem are spoken. Errors
 * also keep their own role="alert" lines below.
 */
const ROUTINE_STATUS = new Set(['Saving locally…', 'Creating local draft…']);
const announcement = ref('');
let announcedSettled = false;
let announcedProblem = false;
watch(() => props.status, (status) => {
  if (!status || ROUTINE_STATUS.has(status)) return;
  if (SETTLED_CALM.has(status) || SETTLED_NON_DURABLE.has(status)) {
    if (!announcedSettled || announcedProblem) announcement.value = statusLine.value.text;
    announcedSettled = true;
    announcedProblem = false;
    return;
  }
  announcement.value = status;
  announcedProblem = true;
}, { immediate: true });

// ---- Recipient / extra fields ---------------------------------------------

const unpreparedReply = computed(() => props.source?.kind === 'reply' && (!props.activeRef?.draftId || props.creating));
/** To still equals the default sender mailbox (or the reply is still being created). */
const toIsDefault = computed(() => isReply.value
  && ((!!props.recipientMailbox && props.content.to === props.recipientMailbox) || (props.content.to === '' && unpreparedReply.value)));
const toEditing = ref(false);
/** The reply shows a name only while it is true; anything else shows the raw To text. */
const showToSummary = computed(() => isReply.value && !toEditing.value && toIsDefault.value);
/**
 * The collapsed row always shows the real address; a display name is context,
 * never a substitute (a sender called "Bank Support" must not hide x@evil.test).
 */
const toAddress = computed(() => props.content.to || (unpreparedReply.value ? props.recipientMailbox ?? '' : ''));
const toName = computed(() => {
  const name = props.recipientLabel?.trim() ?? '';
  return name !== '' && name !== toAddress.value ? name : '';
});
const toSummaryTitle = computed(() => (toAddress.value === '' ? undefined : toName.value ? `${toName.value} <${toAddress.value}>` : toAddress.value));

async function editTo(): Promise<void> {
  toEditing.value = true;
  await nextTick();
  toInput.value?.focus();
}

const extrasOpen = ref(false);
/** Content that must stay visible: a saved Cc or a subject that is not the default "Re:". An edited To is already a visible input. */
const extrasForced = computed(() => props.content.cc !== ''
  || (isReply.value && props.content.subject !== '' && !/^re:/i.test(props.content.subject)));
const extrasShown = computed(() => extrasOpen.value || extrasForced.value);
const ccShown = computed(() => extrasShown.value);
const subjectShown = computed(() => !isReply.value || extrasShown.value);

async function toggleExtras(): Promise<void> {
  if (extrasForced.value) return;
  extrasOpen.value = !extrasOpen.value;
  if (!extrasOpen.value) return;
  await nextTick();
  ccInput.value?.focus();
}

// ---- Focus and body sizing --------------------------------------------------

/** The body grows with its text (up to the CSS max-height); it never shrinks below the CSS minimum. */
function fitBody(): void {
  const el = bodyInput.value;
  if (!el || !el.scrollHeight) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
}

onMounted(fitBody);
watch(() => props.content.bodyText, async () => {
  await nextTick();
  fitBody();
});

/** A text field the user is typing in (or may start typing in): focus is never taken from these. */
function isEditable(el: Element): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    || (el as HTMLElement).isContentEditable === true;
}

/**
 * A disabled field cannot take focus, and a reply editor mounts while its draft
 * is still being created (fields disabled). So the requested focus stays owed
 * until the field is enabled, and is taken from anything that is not a text
 * field: <body>, the button that opened this editor, or reader content such as
 * the article, a Details summary or a participant (the R shortcut can fire from
 * any of them). It is never taken from a text field the user moved to.
 */
let focusOwed = false;
function takeFocus(): void {
  const el = props.autofocus === 'to' ? toInput.value : props.autofocus === 'body' ? bodyInput.value : null;
  if (!el) { focusOwed = false; return; }
  const active = document.activeElement;
  if (active && active !== el && isEditable(active)) { focusOwed = false; return; }
  el.focus();
  focusOwed = document.activeElement !== el;
}

watch(() => props.autofocus, async (field) => {
  if (!field) return;
  focusOwed = true;
  await nextTick();
  takeFocus();
}, { immediate: true });

watch(() => fieldsDisabled(), async (disabled) => {
  if (disabled || !focusOwed) return;
  await nextTick();
  takeFocus();
});

// Move focus into a confirm dialog when it appears, and describe it, so the
// prompt is announced instead of silently appearing.
watch(() => props.confirmDiscard || props.confirmReload, async (open) => {
  if (!open) return;
  await nextTick();
  (dialog.value?.querySelector('button') as HTMLButtonElement | null)?.focus();
});
</script>

<template>
  <div class="composer-body" :class="`composer-body-${props.variant ?? 'new'}`">
    <div class="composer-top">
      <div class="composer-top-main"><slot name="header" /></div>
      <!-- The local-only guarantee is one terse status line. The caveats are
           one extra line behind a focusable toggle (not a tooltip), and the
           body's hidden description. Announcements are quiet, see above. -->
      <div class="composer-status-group">
        <p
          class="draft-status"
          :class="{ 'draft-status-calm': statusLine.calm }"
          data-test="draft-status"
          :title="LOCAL_DETAIL"
        >{{ statusLine.text }}</p>
        <button
          type="button"
          class="composer-caveat-toggle"
          data-test="draft-caveat-toggle"
          aria-label="About local drafts"
          :aria-expanded="caveatOpen"
          :aria-controls="ids.caveat"
          @click="caveatOpen = !caveatOpen"
        ><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.25" /><path d="M8 7.25v4M8 4.75v.01" /></svg></button>
        <span class="visually-hidden" role="status" data-test="draft-status-announce">{{ announcement }}</span>
      </div>
    </div>
    <p v-if="caveatOpen" :id="ids.caveat" class="composer-caveat" data-test="draft-caveat">{{ LOCAL_DETAIL }}</p>
    <p v-if="props.error" role="alert" data-test="draft-error">{{ describe(props.error) }}</p>
    <p v-if="props.createError" role="alert" data-test="draft-create-error">{{ describe(props.createError) }}</p>
    <p v-if="props.closeError" role="alert" data-test="draft-close-error">{{ props.closeError }}</p>
    <div class="composer-fields" :aria-busy="props.saving || props.creating">
      <div class="field-row" data-field="to">
        <label class="field-label" :for="ids.to">To</label>
        <button
          v-if="showToSummary"
          type="button"
          :id="ids.to"
          class="field-summary"
          data-test="draft-to-row"
          :title="toSummaryTitle"
          :disabled="fieldsDisabled()"
          @click="editTo"
        ><template v-if="toAddress === ''">No recipient</template><template v-else><template v-if="toName"><span data-test="draft-to-name">{{ toName }}</span> <span class="field-summary-address" data-test="draft-to-address">&lt;{{ toAddress }}&gt;</span></template><template v-else>{{ toAddress }}</template></template></button>
        <input v-else :id="ids.to" ref="toInput" class="field-input" data-test="draft-to" type="text" autocomplete="off" :value="props.content.to" :disabled="fieldsDisabled()" @input="emit('setField', 'to', ($event.target as HTMLInputElement).value)">
        <button
          type="button"
          class="field-toggle"
          data-test="draft-fields-toggle"
          :aria-expanded="isReply ? extrasShown : ccShown"
          :aria-controls="ids.extras"
          :disabled="fieldsDisabled() || (isReply ? extrasForced : props.content.cc !== '')"
          @click="toggleExtras"
        >{{ isReply ? 'Cc / Subject' : 'Cc' }}</button>
      </div>
      <div :id="ids.extras" class="field-extras">
        <div v-if="ccShown" class="field-row" data-field="cc">
          <label class="field-label" :for="ids.cc">Cc</label>
          <input :id="ids.cc" ref="ccInput" class="field-input" data-test="draft-cc" type="text" autocomplete="off" :value="props.content.cc" :disabled="fieldsDisabled()" @input="emit('setField', 'cc', ($event.target as HTMLInputElement).value)">
        </div>
        <div v-if="subjectShown" class="field-row" data-field="subject">
          <label class="field-label" :for="ids.subject">Subject</label>
          <input :id="ids.subject" class="field-input" data-test="draft-subject" type="text" autocomplete="off" :value="props.content.subject" :disabled="fieldsDisabled()" @input="emit('setField', 'subject', ($event.target as HTMLInputElement).value)">
        </div>
      </div>
      <div class="field-body">
        <label class="visually-hidden" :for="ids.body">Body</label>
        <textarea
          :id="ids.body"
          ref="bodyInput"
          class="field-textarea"
          data-test="draft-body"
          :aria-describedby="ids.detail"
          :value="props.content.bodyText"
          :disabled="fieldsDisabled()"
          @input="emit('setField', 'bodyText', ($event.target as HTMLTextAreaElement).value); fitBody()"
        ></textarea>
        <span :id="ids.detail" class="visually-hidden" data-test="draft-local-detail">{{ LOCAL_DETAIL }}</span>
      </div>
    </div>
    <slot name="context" />
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
    <!-- Footer: one primary action. "Save and close" is the old Close editor: it
         still waits for the protected flush and stays open with the error if the
         flush fails. Esc does the same. There is no Send. -->
    <footer class="composer-footer">
      <button type="button" class="composer-primary" data-test="close-composer" aria-keyshortcuts="Escape" :disabled="props.closing || props.transitioning || props.deleting || props.deletePending" @click="emit('closeEditor')">Save and close</button>
      <kbd class="composer-kbd" aria-hidden="true">Esc</kbd>
      <button v-if="props.canCancelReplyPreparation" type="button" class="composer-quiet" data-test="cancel-reply-preparation" :disabled="props.closing || props.transitioning" @click="emit('cancelReplyPreparation')">Cancel reply preparation</button>
      <button type="button" class="composer-quiet composer-discard" data-test="discard-draft" :disabled="props.closing || props.transitioning || props.discardBusy || props.deleting || props.deletePending || props.creating || props.conflict || !props.activeRef?.draftId" @click="emit('askDiscard')">Discard…</button>
    </footer>
  </div>
</template>
