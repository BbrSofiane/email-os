<script setup lang="ts">
/**
 * The Reminders list context: one Ash coverage line, in-flow recovery lines,
 * the picker host (Remind me / Reschedule) and the rows of the selected tab. The tabs themselves sit in the app header (the split-tab
 * slot) and read the same `model`. All request semantics live in
 * `useReminders`; this component only renders them.
 *
 * In Pending, rows that are not calmly waiting (failed, removing, returning,
 * cancelling) come first under one Ash caption, "Needs attention N"; the tab
 * count covers only phase `pending`. When calm reminders follow, they get their
 * own caption, "Pending N", so the group has a visible end. The data carries no
 * failure cause, so the failed note says what is known and no more, and Cancel
 * is the only action: no retry of a failed reminder exists.
 *
 * The picker is the shared `ReminderPicker` dialog (suggestions plus typed
 * time, its own focus trap and Escape). It dismisses itself with Esc, and
 * anywhere else Esc is the app's Back. A request in flight keeps the picker
 * open and focused. Row keys come from ContextRowList (J/K, arrows, Home, End).
 *
 * The app's key handler reaches the focused row through `rescheduleRow` (H)
 * and `cancelRow` (Shift+H): the same actions as the two row buttons, with the
 * same enabled rules, and a silent `false` for a row that does not offer the
 * action. Cancel keeps its immediate semantics. When a cancelled row leaves the
 * tab while focus is on <body>, focus moves to the next row (else the previous
 * one, else the pane). A polite status line names the tab after `[` / `]` (the
 * tab name alone until the first successful read); a second one says what Cancel
 * reminder or Reschedule did, only after it resolved or failed. Each row's open
 * button is described by its phase, due time, condition and failed note.
 */
import { computed, nextTick, ref, useId, watch } from 'vue';
import type { Reminder } from '../lib/ipc/client';
import { formatReminderDateTime } from '../lib/reminder-timezone';
import { NEEDS_ATTENTION_LABEL, REMINDER_PHASES, REMINDERS_NOTE_DETAIL, REMINDERS_NOTE_LINE, type RemindersModel } from '../composables/useReminders';
import ContextRowList from './ContextRowList.vue';
import FullDate from './FullDate.vue';
import ReminderPicker from './ReminderPicker.vue';

const props = defineProps<{ model: RemindersModel }>();
const emit = defineEmits<{ open: [target: Reminder['conversation']] }>();
const {
  error, preparationError, preparationTarget, busy, loading, source, dueAt, pickerReady, condition, destination,
  displayed, attentionCount, activeRow, retrying, tabAnnouncement, actionAnnouncement, loadedOnce,
} = props.model;

interface ReminderItem { key: string; reminder: Reminder }
const items = computed<ReminderItem[]>(() => displayed.value.map(reminder => ({ key: reminder.conversation.conversationId, reminder })));
const CANCELLABLE = ['removing', 'pending', 'returning', 'failed'];

const paneEl = ref<HTMLElement | null>(null);
const picker = ref<InstanceType<typeof ReminderPicker> | null>(null);
const list = ref<{ focusRow: (key: string | null, options?: { preventScroll?: boolean }) => Promise<void> } | null>(null);

/** Focus the current row, or the pane itself when the tab has no rows. */
async function focusRow(options: { preventScroll?: boolean } = {}): Promise<void> {
  await nextTick();
  // A drawer or overlay that took over covers the pane (inert): it keeps focus.
  if (paneEl.value?.closest('[inert]')) return;
  if (list.value) await list.value.focusRow(activeRow.value, options);
  else paneEl.value?.focus(options);
}

function canReschedule(item: ReminderItem): boolean {
  return item.reminder.phase === 'pending' && !busy.value && !retrying.value;
}
function canCancel(item: ReminderItem): boolean {
  return CANCELLABLE.includes(item.reminder.phase) && !busy.value && !retrying.value;
}
function itemFor(key: string): ReminderItem | undefined {
  return items.value.find(item => item.key === key);
}
/** Open Reschedule for the row with this key, like its button. False when the row offers none. */
function rescheduleRow(key: string): boolean {
  const item = itemFor(key);
  if (!item || !canReschedule(item)) return false;
  props.model.reschedule(item.reminder);
  return true;
}
/** Cancel the row's reminder at once, like its button. False when the row offers none. */
function cancelRow(key: string): boolean {
  const item = itemFor(key);
  if (!item || !canCancel(item)) return false;
  const keys = items.value.map(candidate => candidate.key);
  const index = keys.indexOf(key);
  refocus = { key, neighbour: keys[index + 1] ?? keys[index - 1] ?? null };
  props.model.cancel(item.reminder);
  return true;
}
/** Keep focus inside an open picker while its request cannot be dismissed. */
function retainPickerFocus(): void { picker.value?.focusDialog(); }
defineExpose({ focusRow, rescheduleRow, cancelRow, retainPickerFocus, el: paneEl });

// A cancelled row leaves the tab a moment later. If it had keyboard focus, focus
// would fall to <body>, where the row keys no longer work.
let refocus: { key: string; neighbour: string | null } | null = null;
watch(() => items.value.map(item => item.key), async (keys) => {
  if (!refocus || keys.includes(refocus.key)) return;
  const { neighbour } = refocus;
  refocus = null;
  await nextTick();
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  if (neighbour !== null && keys.includes(neighbour)) activeRow.value = neighbour;
  await focusRow();
});
/** Focus that moves to any other row ends the pending refocus. */
function onPaneFocusin(event: FocusEvent): void {
  const target = event.target;
  if (refocus && !(target instanceof HTMLElement && target.dataset.drawerRow === refocus.key)) refocus = null;
}

// The picker dialog takes focus when it opens; when it closes while focus fell to
// <body>, focus returns to the rows.
watch(source, async (next, previous) => {
  await nextTick();
  if (!next && previous && (document.activeElement === document.body || document.activeElement === null)) await focusRow();
});

async function dismiss() {
  if (props.model.dismissBlocked.value) { retainPickerFocus(); return; }
  props.model.closePicker();
  await nextTick();
  // The closed picker took its focus with it; anything else that has focus keeps it.
  if (!document.activeElement || document.activeElement === document.body) await focusRow();
}
/** Quiet captions: "Needs attention N" before the first row when rows need attention, and "Pending N" before the first calm row when both groups exist. */
function groupCaption(_item: ReminderItem, index: number): string | null {
  const attention = attentionCount.value;
  if (attention === 0) return null;
  if (index === 0) return `${NEEDS_ATTENTION_LABEL} ${attention}`;
  // The calm rows get their own caption, so the Needs attention group has a visible end.
  return index === attention ? `Pending ${items.value.length - attention}` : null;
}
function rowTitle(item: ReminderItem): string { return `Revision ${item.reminder.revision}`; }

// The open button's name is only "Open <subject>". The state beside it (phase,
// due time, condition, failed note) is tied to it by `aria-describedby`, so a
// screen reader reads it with the row. The phase word also carries what the
// "Needs attention" caption means, which is a presentation item.
const uid = useId();
type DescriptionPart = 'phase' | 'due' | 'condition' | 'note';
function descId(item: ReminderItem, part: DescriptionPart): string {
  return `${uid}-${item.key.replace(/\s/g, '_')}-${part}`;
}
function describedBy(item: ReminderItem): string {
  const parts: DescriptionPart[] = ['phase', 'due'];
  if (item.reminder.condition === 'regardless') parts.push('condition');
  if (item.reminder.phase === 'failed') parts.push('note');
  return parts.map(part => descId(item, part)).join(' ');
}
</script>

<template>
  <div ref="paneEl" class="context-pane" data-test="reminders-panel" tabindex="-1" @focusin="onPaneFocusin">
    <!-- Honest state, once: the device-local note is visible; the rest is its title and hidden text. -->
    <div class="context-coverage">
      <p class="cached-coverage" role="note" data-test="reminders-coverage" :title="REMINDERS_NOTE_DETAIL">{{ REMINDERS_NOTE_LINE }}<span class="visually-hidden"> · {{ REMINDERS_NOTE_DETAIL }}</span></p>
      <button type="button" class="drawer-quiet" data-test="reminders-refresh" :disabled="busy" @click="model.retryOrRefresh()">{{ retrying ? 'Retry exact request' : 'Refresh reminders' }}</button>
    </div>
    <div v-if="error" class="recovery-banner" data-test="reminders-error">
      <p role="alert">{{ error }}</p>
      <button v-if="retrying" type="button" :disabled="busy" @click="model.inspectSavedState()">Inspect saved state</button>
    </div>
    <div v-if="preparationError" class="recovery-banner" data-test="reminders-preparation-error">
      <p role="alert">{{ preparationError }}</p>
      <button v-if="preparationTarget" type="button" :disabled="busy || retrying" @click="model.prepare(preparationTarget)">{{ busy ? 'Preparing conversation…' : 'Retry preparation / refresh conversation' }}</button>
    </div>
    <div
      v-if="source"
      class="reminder-form"
      data-test="reminder-form"
      :data-source-conversation="source.conversation.conversationId"
      :data-source-message="source.sourceMessageId"
    >
      <h2 class="drawer-section-title">{{ source.revision === null ? 'Remind me' : 'Reschedule reminder' }}</h2>
      <p class="drawer-note">Conversation ready</p>
      <ReminderPicker
        ref="picker"
        :disabled="busy || retrying"
        :initial-value="dueAt"
        :rescheduling="source.revision !== null"
        :subject="source.subject"
        :sender="source.sender"
        @select="model.selectTime"
        @editing="model.editTime"
        @dismiss="dismiss"
      >
        <p v-if="error" role="alert">{{ error }}</p>
        <button v-if="retrying" type="button" :disabled="busy" @click="model.retryOrRefresh()">Retry exact request</button>
        <button v-if="retrying" type="button" :disabled="busy" @click="model.inspectSavedState()">Inspect saved state</button>
        <label class="condition">Return condition
          <select v-model="condition" :disabled="busy || retrying"><option value="if_no_reply">If no reply</option><option value="regardless">Return regardless of reply</option></select>
        </label>
        <p v-if="dueAt" class="chosen-time">Selected: <time :datetime="dueAt">{{ formatReminderDateTime(dueAt) }}</time></p>
        <p v-else-if="pickerReady" class="chosen-time">Selected: Someday</p>
        <button type="button" :disabled="busy || retrying || !pickerReady" @click="model.submit()">{{ busy ? 'Saving reminder…' : source.revision === null ? 'Schedule reminder' : 'Save new time' }}</button>
      </ReminderPicker>
    </div>
    <!-- Names the tab after `[` / `]`; mounted all the time so each change is announced. -->
    <p class="visually-hidden" role="status" aria-live="polite" data-test="reminders-tab-status">{{ tabAnnouncement }}</p>
    <!-- Says what Cancel reminder / Reschedule did, only after it resolved or failed. -->
    <p class="visually-hidden" role="status" aria-live="polite" data-test="reminders-action-status">{{ actionAnnouncement }}</p>
    <div id="reminder-tabpanel" role="tabpanel" :aria-labelledby="`reminder-tab-${destination}`">
      <p v-if="loading" class="list-state" role="status">Loading local reminders…</p>
      <!-- Before the first successful read an empty list means "not read", not "none": the error above says so. -->
      <p v-else-if="loadedOnce && !displayed.length" class="list-state" data-test="reminders-empty">No {{ destination }} reminders.</p>
      <ContextRowList
        v-if="items.length"
        ref="list"
        :items="items"
        :label="`${destination[0]!.toUpperCase()}${destination.slice(1)} reminders`"
        :active-key="activeRow"
        :row-title="rowTitle"
        :group-caption="groupCaption"
        :described-by="describedBy"
        :row-test-id="(item: ReminderItem) => `reminder-row-${item.key}`"
        @update:active-key="activeRow = $event"
        @open="emit('open', $event.reminder.conversation)"
      >
        <template #primary="{ item }"><span class="context-subject">{{ item.reminder.subject || '(No subject)' }}</span></template>
        <template #secondary="{ item }"><span v-if="item.reminder.condition === 'regardless'" :id="descId(item, 'condition')" data-test="reminder-condition">Returns regardless of reply</span></template>
        <template #actions="{ item }">
          <button v-if="item.reminder.phase === 'pending'" type="button" class="drawer-quiet" title="Reschedule — H" aria-keyshortcuts="H" :disabled="busy || retrying" @click="model.reschedule(item.reminder)">Reschedule</button>
          <button
            v-if="CANCELLABLE.includes(item.reminder.phase)"
            type="button"
            class="drawer-quiet"
            :aria-label="item.reminder.phase === 'failed' ? 'Cancel and show original inbox messages' : 'Cancel reminder and show in Inbox'"
            :title="`${item.reminder.phase === 'failed' ? 'Cancel and show original inbox messages' : 'Cancel reminder and show in Inbox'} — Shift+H`"
            aria-keyshortcuts="Shift+H"
            :disabled="busy || retrying"
            @click="model.cancel(item.reminder)"
          >Cancel reminder</button>
        </template>
        <template #trailing="{ item }">
          <span :id="descId(item, 'due')" class="context-date"><FullDate v-if="item.reminder.dueAt" :at="item.reminder.dueAt" /><template v-else>Someday</template></span>
          <span :id="descId(item, 'phase')" class="activity-status context-phase" :class="`tone-${REMINDER_PHASES[item.reminder.phase].tone}`" :data-test="`reminder-phase-${item.reminder.phase}`">{{ REMINDER_PHASES[item.reminder.phase].word }}</span>
        </template>
        <template #note="{ item }">
          <p v-if="item.reminder.phase === 'failed'" :id="descId(item, 'note')" class="context-row-note tone-fault">A mailbox change failed or newer triage superseded it; which one is not recorded. Cancel does not override newer triage.</p>
        </template>
      </ContextRowList>
    </div>
  </div>
</template>

<style scoped>
.reminder-form { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 6px 24px 12px 50px; overflow-wrap: anywhere; }
.reminder-form .drawer-section-title, .reminder-form .drawer-note { margin: 0; }
.condition { display: grid; gap: 4px; color: var(--text-secondary); }
.condition select { width: 100%; min-width: 0; padding: 4px 8px; color: var(--text-primary); }
.chosen-time { margin: 0; color: var(--text-secondary); }
.picker-controls > button { width: min(100%, 23rem); }
</style>
